import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { getOwnEmployeeId } from '../utils/ownEmployee';
import { getHrScope, isEmployeeInHrScope } from '../utils/hrScope';
import { logAudit } from '../utils/audit';

const SCORE_FIELDS = `id, employee_id, cycle_id, okr_score, feedback_score, final_score, bonus_amount, payroll_adjustment_id, status, created_by, created_at, updated_at`;

export const listScores = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { employee_id, cycle_id } = req.query;

  const params: unknown[] = [companyId];
  let where = 'ps.company_id = $1';

  // Department-scoped since the 2026-08-26 HR-visibility fix (hrScope.ts) —
  // same override-can-only-narrow pattern as attendance/leaveRequests list().
  const scope = await getHrScope(companyId, req.auth!.userId, req.auth!.role);
  if (scope.level === 'self') {
    const ownEmployeeId = await getOwnEmployeeId(req.auth!.userId, companyId);
    params.push(ownEmployeeId);
    where += ` AND ps.employee_id = $${params.length}`;
  } else {
    if (scope.level === 'department') {
      params.push(scope.departmentIds);
      where += ` AND e.department_id = ANY($${params.length}::uuid[])`;
    }
    if (typeof employee_id === 'string') {
      params.push(employee_id);
      where += ` AND ps.employee_id = $${params.length}`;
    }
  }
  if (typeof cycle_id === 'string') {
    params.push(cycle_id);
    where += ` AND ps.cycle_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT ps.id, ps.employee_id, e.name AS employee_name, ps.cycle_id, ps.okr_score, ps.feedback_score,
            ps.final_score, ps.bonus_amount, ps.payroll_adjustment_id, ps.status, ps.created_at, ps.updated_at
     FROM performance_scores ps JOIN employees e ON e.id = ps.employee_id AND e.company_id = ps.company_id
     WHERE ${where} ORDER BY ps.created_at DESC`,
    params
  );
  res.status(200).json({ success: true, scores: result.rows });
});

// Admin/manager only (route-gated) — sets/updates the draft score for one
// employee+cycle. Upserts on the table's UNIQUE (employee_id, cycle_id).
export const upsertScore = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { employee_id, cycle_id, okr_score, feedback_score, final_score, bonus_amount } = req.body ?? {};

  if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id is required');
  if (typeof cycle_id !== 'string') throw new AppError(400, 'cycle_id is required');

  const employee = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [employee_id, companyId]);
  if (!employee.rows[0]) throw new AppError(404, 'Employee not found');
  const cycle = await pool.query('SELECT id FROM feedback_cycles WHERE id = $1 AND company_id = $2', [cycle_id, companyId]);
  if (!cycle.rows[0]) throw new AppError(404, 'Cycle not found');

  // Added 2026-08-27: route was admin/manager-only with no per-employee scope check —
  // a department-scoped manager could set/finalize a bonus payout (-> payroll) for
  // any employee company-wide, not just their own team.
  {
    const scope = await getHrScope(companyId, req.auth!.userId, req.auth!.role);
    if (!(await isEmployeeInHrScope(companyId, scope, employee_id))) {
      throw new AppError(403, 'You do not have permission to score this employee.');
    }
  }

  const result = await pool.query(
    `INSERT INTO performance_scores (company_id, employee_id, cycle_id, okr_score, feedback_score, final_score, bonus_amount, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (employee_id, cycle_id) DO UPDATE SET
       okr_score = EXCLUDED.okr_score, feedback_score = EXCLUDED.feedback_score, final_score = EXCLUDED.final_score,
       bonus_amount = EXCLUDED.bonus_amount, updated_at = NOW()
     RETURNING ${SCORE_FIELDS}`,
    [
      companyId,
      employee_id,
      cycle_id,
      okr_score ?? null,
      feedback_score ?? null,
      final_score ?? null,
      typeof bonus_amount === 'number' ? bonus_amount : 0,
      req.auth!.userId,
    ]
  );

  res.status(200).json({ success: true, score: result.rows[0] });
});

// Posts the bonus as an actual payroll_adjustments row (type='bonus') against a
// specific month's payroll — admin/manager only. The score can't be finalized twice
// (it already has a payroll_adjustment_id once posted).
//
// KNOWN INTERACTION (flag for Step 3/frontend): payroll.controller.ts's update()
// deletes and fully replaces a payroll row's adjustments from whatever list the
// PayrollPage form submits. If that form doesn't know to re-include a
// performance-bonus row added here, a later unrelated payroll edit would silently
// wipe it. The Payroll UI needs to fetch and preserve performance-linked adjustments
// (or performanceScores.controller.ts needs to re-verify/re-insert after any payroll
// update) before this is fully safe end-to-end — noted, not fixed in this pass.
export const finalizeScore = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { payroll_id } = req.body ?? {};
  if (typeof payroll_id !== 'string') throw new AppError(400, 'payroll_id is required');

  const score = await pool.query('SELECT * FROM performance_scores WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!score.rows[0]) throw new AppError(404, 'Performance score not found');
  {
    const scope = await getHrScope(companyId, req.auth!.userId, req.auth!.role);
    if (!(await isEmployeeInHrScope(companyId, scope, score.rows[0].employee_id))) {
      throw new AppError(403, 'You do not have permission to finalize this employee\'s score.');
    }
  }
  if (score.rows[0].payroll_adjustment_id) throw new AppError(400, 'This score has already been finalized to payroll');
  if (!score.rows[0].bonus_amount || Number(score.rows[0].bonus_amount) <= 0) {
    throw new AppError(400, 'bonus_amount must be greater than 0 to finalize');
  }

  const payroll = await pool.query('SELECT id, employee_id FROM payroll WHERE id = $1 AND company_id = $2', [payroll_id, companyId]);
  if (!payroll.rows[0]) throw new AppError(404, 'Payroll record not found');
  if (payroll.rows[0].employee_id !== score.rows[0].employee_id) {
    throw new AppError(400, 'That payroll record belongs to a different employee than this score');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const adjustment = await client.query(
      `INSERT INTO payroll_adjustments (company_id, payroll_id, type, label, amount, created_by)
       VALUES ($1, $2, 'bonus', 'Performance bonus', $3, $4)
       RETURNING id`,
      [companyId, payroll_id, score.rows[0].bonus_amount, req.auth!.userId]
    );
    await client.query(
      `UPDATE performance_scores SET payroll_adjustment_id = $1, status = 'finalized', updated_at = NOW() WHERE id = $2`,
      [adjustment.rows[0].id, id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: 'performance_score_finalized',
    entityType: 'performance_scores',
    entityId: id as string,
    req,
  });

  const updated = await pool.query(`SELECT ${SCORE_FIELDS} FROM performance_scores WHERE id = $1`, [id]);
  res.status(200).json({ success: true, score: updated.rows[0] });
});
