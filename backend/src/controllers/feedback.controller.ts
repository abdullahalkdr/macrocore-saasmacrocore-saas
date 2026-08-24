import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { getOwnEmployeeId } from '../utils/ownEmployee';

const CYCLE_STATUSES = ['draft', 'open', 'closed'];
const REVIEWER_TYPES = ['self', 'manager', 'peer', 'subordinate', 'external'];

const CYCLE_FIELDS = `id, form_id, name, name_en, period_start, period_end, status, created_by, created_at, updated_at`;
const REQUEST_FIELDS = `id, cycle_id, subject_employee_id, reviewer_employee_id, reviewer_type, status, overall_score, submitted_at, created_at`;

// --- Cycles (admin/manager config — gated at the route level) ---------------------

export const listCycles = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const cycles = await pool.query(`SELECT ${CYCLE_FIELDS} FROM feedback_cycles WHERE company_id = $1 ORDER BY period_start DESC`, [companyId]);
  res.status(200).json({ success: true, cycles: cycles.rows });
});

export const createCycle = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { form_id, name, name_en, period_start, period_end } = req.body ?? {};

  if (typeof name !== 'string' || !name.trim()) throw new AppError(400, 'name is required');
  if (typeof period_start !== 'string') throw new AppError(400, 'period_start is required (YYYY-MM-DD)');
  if (typeof period_end !== 'string') throw new AppError(400, 'period_end is required (YYYY-MM-DD)');

  const result = await pool.query(
    `INSERT INTO feedback_cycles (company_id, form_id, name, name_en, period_start, period_end, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${CYCLE_FIELDS}`,
    [companyId, form_id ?? null, name.trim(), name_en ?? null, period_start, period_end, req.auth!.userId]
  );
  res.status(201).json({ success: true, cycle: result.rows[0] });
});

export const updateCycle = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { name, name_en, period_start, period_end, status } = req.body ?? {};

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) throw new AppError(400, 'name must be a non-empty string');
    sets.push(`name = $${i++}`);
    values.push(name.trim());
  }
  if (name_en !== undefined) {
    sets.push(`name_en = $${i++}`);
    values.push(name_en);
  }
  if (period_start !== undefined) {
    sets.push(`period_start = $${i++}`);
    values.push(period_start);
  }
  if (period_end !== undefined) {
    sets.push(`period_end = $${i++}`);
    values.push(period_end);
  }
  if (status !== undefined) {
    if (!CYCLE_STATUSES.includes(status)) throw new AppError(400, `status must be one of ${CYCLE_STATUSES.join(', ')}`);
    sets.push(`status = $${i++}`);
    values.push(status);
  }
  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push('updated_at = NOW()');
  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE feedback_cycles SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++} RETURNING ${CYCLE_FIELDS}`,
    values
  );
  if (!result.rows[0]) throw new AppError(404, 'Cycle not found');

  res.status(200).json({ success: true, cycle: result.rows[0] });
});

// --- Requests (reviewer assignments) -----------------------------------------------

// Bulk-assign reviewers for a cycle — admin/manager only (route-gated).
export const createRequests = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id: cycleId } = req.params;
  const { requests } = req.body ?? {};

  const cycle = await pool.query('SELECT id FROM feedback_cycles WHERE id = $1 AND company_id = $2', [cycleId, companyId]);
  if (!cycle.rows[0]) throw new AppError(404, 'Cycle not found');

  if (!Array.isArray(requests) || requests.length === 0) throw new AppError(400, 'requests must be a non-empty array');
  for (const r of requests) {
    if (typeof r.subject_employee_id !== 'string' || typeof r.reviewer_employee_id !== 'string') {
      throw new AppError(400, 'each request needs subject_employee_id and reviewer_employee_id');
    }
    if (r.reviewer_type !== undefined && !REVIEWER_TYPES.includes(r.reviewer_type)) {
      throw new AppError(400, `reviewer_type must be one of ${REVIEWER_TYPES.join(', ')}`);
    }
  }

  // Security fix (tenant-isolation audit, finding C5): subject_employee_id and
  // reviewer_employee_id were inserted with NO company check at all — not even a
  // self-pin fallback like C1/C4, since this endpoint is always admin/manager-only
  // (route-gated). Batch-checks every referenced id in one query since a bulk
  // assignment call can carry many requests.
  const employeeIds = [...new Set(requests.flatMap((r) => [r.subject_employee_id, r.reviewer_employee_id]))];
  const employeeCheck = await pool.query('SELECT id FROM employees WHERE id = ANY($1::uuid[]) AND company_id = $2', [employeeIds, companyId]);
  if (employeeCheck.rows.length !== employeeIds.length) {
    throw new AppError(400, 'One or more subject_employee_id/reviewer_employee_id values do not belong to this company');
  }

  const client = await pool.connect();
  const created: unknown[] = [];
  try {
    await client.query('BEGIN');
    for (const r of requests) {
      const result = await client.query(
        `INSERT INTO feedback_requests (company_id, cycle_id, subject_employee_id, reviewer_employee_id, reviewer_type)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${REQUEST_FIELDS}`,
        [companyId, cycleId, r.subject_employee_id, r.reviewer_employee_id, r.reviewer_type ?? 'peer']
      );
      created.push(result.rows[0]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({ success: true, requests: created });
});

// Admin/manager triage view — any cycle/subject/reviewer, filterable.
export const listRequests = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { cycle_id, subject_employee_id, reviewer_employee_id, status } = req.query;

  const params: unknown[] = [companyId];
  let where = 'fr.company_id = $1';
  if (typeof cycle_id === 'string') {
    params.push(cycle_id);
    where += ` AND fr.cycle_id = $${params.length}`;
  }
  if (typeof subject_employee_id === 'string') {
    params.push(subject_employee_id);
    where += ` AND fr.subject_employee_id = $${params.length}`;
  }
  if (typeof reviewer_employee_id === 'string') {
    params.push(reviewer_employee_id);
    where += ` AND fr.reviewer_employee_id = $${params.length}`;
  }
  if (typeof status === 'string') {
    params.push(status);
    where += ` AND fr.status = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT fr.id, fr.cycle_id, fr.subject_employee_id, s.name AS subject_name, fr.reviewer_employee_id,
            r.name AS reviewer_name, fr.reviewer_type, fr.status, fr.overall_score, fr.submitted_at, fr.created_at
     FROM feedback_requests fr
     JOIN employees s ON s.id = fr.subject_employee_id AND s.company_id = fr.company_id
     JOIN employees r ON r.id = fr.reviewer_employee_id AND r.company_id = fr.company_id
     WHERE ${where} ORDER BY fr.created_at DESC`,
    params
  );
  res.status(200).json({ success: true, requests: result.rows });
});

// "Feedback I need to give" — any role, own reviewer_employee_id only.
export const listMyRequests = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const ownEmployeeId = await getOwnEmployeeId(req.auth!.userId, companyId);
  const { status } = req.query;

  const params: unknown[] = [companyId, ownEmployeeId];
  let where = 'fr.company_id = $1 AND fr.reviewer_employee_id = $2';
  if (typeof status === 'string') {
    params.push(status);
    where += ` AND fr.status = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT fr.id, fr.cycle_id, c.name AS cycle_name, fr.subject_employee_id, s.name AS subject_name,
            fr.reviewer_type, fr.status, fr.submitted_at, fr.created_at
     FROM feedback_requests fr
     JOIN employees s ON s.id = fr.subject_employee_id AND s.company_id = fr.company_id
     JOIN feedback_cycles c ON c.id = fr.cycle_id AND c.company_id = fr.company_id
     WHERE ${where} ORDER BY fr.created_at DESC`,
    params
  );
  res.status(200).json({ success: true, requests: result.rows });
});

// Reviewer submits their scores/comments — must BE the assigned reviewer (any role:
// a manager or admin can be a reviewer too), regardless of who's logged in.
export const submitAnswers = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id: requestId } = req.params;
  const { answers } = req.body ?? {};

  const request = await pool.query(
    'SELECT id, reviewer_employee_id, status FROM feedback_requests WHERE id = $1 AND company_id = $2',
    [requestId, companyId]
  );
  if (!request.rows[0]) throw new AppError(404, 'Feedback request not found');

  const ownEmployeeId = await getOwnEmployeeId(req.auth!.userId, companyId);
  if (request.rows[0].reviewer_employee_id !== ownEmployeeId) {
    throw new AppError(403, 'You are not the assigned reviewer for this feedback request');
  }
  if (request.rows[0].status === 'submitted') throw new AppError(400, 'This feedback has already been submitted');

  if (!Array.isArray(answers) || answers.length === 0) throw new AppError(400, 'answers must be a non-empty array');
  for (const a of answers) {
    if (typeof a.question_id !== 'string' || typeof a.score !== 'number') {
      throw new AppError(400, 'each answer needs question_id and a numeric score');
    }
  }

  const questions = await pool.query(
    `SELECT id, max_score, weight FROM appraisal_form_questions WHERE id = ANY($1) AND company_id = $2`,
    [answers.map((a: { question_id: string }) => a.question_id), companyId]
  );
  const questionById = new Map(questions.rows.map((q) => [q.id, q]));

  let weightedSum = 0;
  let weightTotal = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const a of answers) {
      const question = questionById.get(a.question_id);
      if (!question) throw new AppError(400, `Unknown question_id: ${a.question_id}`);
      await client.query(
        `INSERT INTO feedback_answers (company_id, feedback_request_id, question_id, score, comment)
         VALUES ($1, $2, $3, $4, $5)`,
        [companyId, requestId, a.question_id, a.score, a.comment ?? null]
      );
      const normalized = Number(question.max_score) > 0 ? (a.score / Number(question.max_score)) * 100 : 0;
      weightedSum += normalized * Number(question.weight);
      weightTotal += Number(question.weight);
    }
    const overallScore = weightTotal > 0 ? weightedSum / weightTotal : null;
    await client.query(
      `UPDATE feedback_requests SET status = 'submitted', submitted_at = NOW(), overall_score = $1 WHERE id = $2`,
      [overallScore, requestId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.status(200).json({ success: true });
});

// Aggregated per-question results for one subject — admin/manager for anyone,
// employee for themselves only.
export const getResults = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { subjectEmployeeId } = req.params;
  const { cycle_id } = req.query;

  if (req.auth!.role === 'employee') {
    const ownEmployeeId = await getOwnEmployeeId(req.auth!.userId, companyId);
    if (subjectEmployeeId !== ownEmployeeId) throw new AppError(404, 'Not found');
  }

  const params: unknown[] = [companyId, subjectEmployeeId];
  let where = 'fr.company_id = $1 AND fr.subject_employee_id = $2 AND fr.status = \'submitted\'';
  if (typeof cycle_id === 'string') {
    params.push(cycle_id);
    where += ` AND fr.cycle_id = $${params.length}`;
  }

  const summary = await pool.query(
    `SELECT fr.cycle_id, c.name AS cycle_name, COUNT(DISTINCT fr.id)::int AS reviewer_count, AVG(fr.overall_score) AS average_overall_score
     FROM feedback_requests fr JOIN feedback_cycles c ON c.id = fr.cycle_id AND c.company_id = fr.company_id
     WHERE ${where} GROUP BY fr.cycle_id, c.name`,
    params
  );

  const perQuestion = await pool.query(
    `SELECT fa.question_id, q.question_text, q.question_text_en, AVG(fa.score) AS average_score, COUNT(*)::int AS answer_count
     FROM feedback_answers fa
     JOIN feedback_requests fr ON fr.id = fa.feedback_request_id AND fr.company_id = fa.company_id
     JOIN appraisal_form_questions q ON q.id = fa.question_id AND q.company_id = fa.company_id
     WHERE ${where} GROUP BY fa.question_id, q.question_text, q.question_text_en`,
    params
  );

  res.status(200).json({ success: true, cycles: summary.rows, questions: perQuestion.rows });
});
