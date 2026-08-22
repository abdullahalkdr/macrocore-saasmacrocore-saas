import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { getOwnEmployeeId } from '../utils/ownEmployee';
import { logAudit } from '../utils/audit';

const OBJECTIVE_STATUSES = ['draft', 'active', 'completed', 'cancelled'];
const KEY_RESULT_STATUSES = ['on_track', 'at_risk', 'off_track', 'done'];
const METRIC_TYPES = ['number', 'percentage', 'currency', 'boolean'];

const OBJECTIVE_FIELDS = `id, employee_id, title, title_en, description, period_start, period_end, status, progress_pct, created_by, created_at, updated_at`;
const KEY_RESULT_FIELDS = `id, objective_id, title, title_en, metric_type, unit, start_value, target_value, current_value, weight, status, created_at, updated_at`;

async function assertOwnsObjective(objectiveId: string, companyId: string, auth: { userId: string; role: string }): Promise<string> {
  const result = await pool.query('SELECT employee_id FROM okr_objectives WHERE id = $1 AND company_id = $2', [objectiveId, companyId]);
  if (!result.rows[0]) throw new AppError(404, 'Objective not found');
  if (auth.role === 'employee') {
    const ownEmployeeId = await getOwnEmployeeId(auth.userId, companyId);
    if (result.rows[0].employee_id !== ownEmployeeId) throw new AppError(404, 'Objective not found');
  }
  return result.rows[0].employee_id;
}

export const listObjectives = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { employee_id, status } = req.query;

  const params: unknown[] = [companyId];
  let where = 'o.company_id = $1';

  if (req.auth!.role === 'employee') {
    const ownEmployeeId = await getOwnEmployeeId(req.auth!.userId, companyId);
    params.push(ownEmployeeId);
    where += ` AND o.employee_id = $${params.length}`;
  } else if (typeof employee_id === 'string') {
    params.push(employee_id);
    where += ` AND o.employee_id = $${params.length}`;
  }
  if (typeof status === 'string') {
    params.push(status);
    where += ` AND o.status = $${params.length}`;
  }

  const objectives = await pool.query(
    `SELECT o.id, o.employee_id, o.title, o.title_en, o.description, o.period_start, o.period_end,
            o.status, o.progress_pct, o.created_by, o.created_at, o.updated_at, e.name AS employee_name
     FROM okr_objectives o JOIN employees e ON e.id = o.employee_id
     WHERE ${where} ORDER BY o.period_start DESC, o.created_at DESC`,
    params
  );

  if (objectives.rows.length === 0) return res.status(200).json({ success: true, objectives: [] });

  const objectiveIds = objectives.rows.map((o) => o.id);
  const keyResults = await pool.query(
    `SELECT ${KEY_RESULT_FIELDS} FROM okr_key_results WHERE objective_id = ANY($1) ORDER BY created_at ASC`,
    [objectiveIds]
  );
  const byObjective = new Map<string, unknown[]>();
  for (const kr of keyResults.rows) {
    const list = byObjective.get(kr.objective_id) ?? [];
    list.push(kr);
    byObjective.set(kr.objective_id, list);
  }

  res.status(200).json({
    success: true,
    objectives: objectives.rows.map((o) => ({ ...o, key_results: byObjective.get(o.id) ?? [] })),
  });
});

export const createObjective = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  let { employee_id, title, title_en, description, period_start, period_end } = req.body ?? {};

  if (req.auth!.role === 'employee') {
    employee_id = await getOwnEmployeeId(req.auth!.userId, companyId);
  }
  if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id is required');
  if (typeof title !== 'string' || !title.trim()) throw new AppError(400, 'title is required');
  if (typeof period_start !== 'string') throw new AppError(400, 'period_start is required (YYYY-MM-DD)');
  if (typeof period_end !== 'string') throw new AppError(400, 'period_end is required (YYYY-MM-DD)');

  const result = await pool.query(
    `INSERT INTO okr_objectives (company_id, employee_id, title, title_en, description, period_start, period_end, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${OBJECTIVE_FIELDS}`,
    [companyId, employee_id, title.trim(), title_en ?? null, description ?? null, period_start, period_end, req.auth!.userId]
  );
  const objective = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'okr_objective_created', entityType: 'okr_objectives', entityId: objective.id, req });

  res.status(201).json({ success: true, objective });
});

export const updateObjective = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  await assertOwnsObjective(id, companyId, req.auth!);

  const { title, title_en, description, period_start, period_end, status, progress_pct } = req.body ?? {};
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) throw new AppError(400, 'title must be a non-empty string');
    sets.push(`title = $${i++}`);
    values.push(title.trim());
  }
  if (title_en !== undefined) {
    sets.push(`title_en = $${i++}`);
    values.push(title_en);
  }
  if (description !== undefined) {
    sets.push(`description = $${i++}`);
    values.push(description);
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
    if (!OBJECTIVE_STATUSES.includes(status)) throw new AppError(400, `status must be one of ${OBJECTIVE_STATUSES.join(', ')}`);
    sets.push(`status = $${i++}`);
    values.push(status);
  }
  if (progress_pct !== undefined) {
    if (typeof progress_pct !== 'number' || progress_pct < 0 || progress_pct > 100) throw new AppError(400, 'progress_pct must be 0-100');
    sets.push(`progress_pct = $${i++}`);
    values.push(progress_pct);
  }
  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push('updated_at = NOW()');
  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE okr_objectives SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++} RETURNING ${OBJECTIVE_FIELDS}`,
    values
  );

  res.status(200).json({ success: true, objective: result.rows[0] });
});

// Admin/manager only at the route level — deleting performance history isn't
// something a plain employee should be able to do to their own record.
export const removeObjective = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query('DELETE FROM okr_objectives WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (!result.rows[0]) throw new AppError(404, 'Objective not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'okr_objective_deleted', entityType: 'okr_objectives', entityId: id as string, req });

  res.status(200).json({ success: true });
});

export const createKeyResult = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id: objectiveId } = req.params;
  await assertOwnsObjective(objectiveId, companyId, req.auth!);

  const { title, title_en, metric_type, unit, start_value, target_value, weight } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) throw new AppError(400, 'title is required');
  const finalMetricType = typeof metric_type === 'string' && METRIC_TYPES.includes(metric_type) ? metric_type : 'number';

  const result = await pool.query(
    `INSERT INTO okr_key_results (company_id, objective_id, title, title_en, metric_type, unit, start_value, target_value, weight)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${KEY_RESULT_FIELDS}`,
    [
      companyId,
      objectiveId,
      title.trim(),
      title_en ?? null,
      finalMetricType,
      unit ?? null,
      typeof start_value === 'number' ? start_value : 0,
      target_value ?? null,
      typeof weight === 'number' ? weight : 1,
    ]
  );

  res.status(201).json({ success: true, key_result: result.rows[0] });
});

export const updateKeyResult = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const existing = await pool.query(
    `SELECT kr.id, o.id AS objective_id FROM okr_key_results kr JOIN okr_objectives o ON o.id = kr.objective_id
     WHERE kr.id = $1 AND kr.company_id = $2`,
    [id, companyId]
  );
  if (!existing.rows[0]) throw new AppError(404, 'Key result not found');
  await assertOwnsObjective(existing.rows[0].objective_id, companyId, req.auth!);

  const { title, title_en, current_value, start_value, target_value, unit, weight, status } = req.body ?? {};
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) throw new AppError(400, 'title must be a non-empty string');
    sets.push(`title = $${i++}`);
    values.push(title.trim());
  }
  if (title_en !== undefined) {
    sets.push(`title_en = $${i++}`);
    values.push(title_en);
  }
  if (current_value !== undefined) {
    if (typeof current_value !== 'number') throw new AppError(400, 'current_value must be a number');
    sets.push(`current_value = $${i++}`);
    values.push(current_value);
  }
  if (start_value !== undefined) {
    if (typeof start_value !== 'number') throw new AppError(400, 'start_value must be a number');
    sets.push(`start_value = $${i++}`);
    values.push(start_value);
  }
  if (target_value !== undefined) {
    sets.push(`target_value = $${i++}`);
    values.push(target_value);
  }
  if (unit !== undefined) {
    sets.push(`unit = $${i++}`);
    values.push(unit);
  }
  if (weight !== undefined) {
    if (typeof weight !== 'number' || weight < 0) throw new AppError(400, 'weight must be a non-negative number');
    sets.push(`weight = $${i++}`);
    values.push(weight);
  }
  if (status !== undefined) {
    if (!KEY_RESULT_STATUSES.includes(status)) throw new AppError(400, `status must be one of ${KEY_RESULT_STATUSES.join(', ')}`);
    sets.push(`status = $${i++}`);
    values.push(status);
  }
  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push('updated_at = NOW()');
  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE okr_key_results SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++} RETURNING ${KEY_RESULT_FIELDS}`,
    values
  );

  res.status(200).json({ success: true, key_result: result.rows[0] });
});

// Admin/manager only at the route level, same reasoning as removeObjective.
export const removeKeyResult = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query('DELETE FROM okr_key_results WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (!result.rows[0]) throw new AppError(404, 'Key result not found');

  res.status(200).json({ success: true });
});
