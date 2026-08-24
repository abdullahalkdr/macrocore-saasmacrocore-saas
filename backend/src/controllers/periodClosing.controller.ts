import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { isUniqueViolation } from '../utils/dbErrors';

// Period Closing module (MIGRATION_053) — Settings > Setup > Period closing.
// Not a CRUD entity like Cost Centers/Projects: a closed_periods row is only
// ever inserted (close) or deleted (reopen), never updated, so there's no
// update() here. Same company-scoped, strict read-time company_id JOIN
// matching per the tenant isolation audit (SECURITY_AUDIT_TENANT_ISOLATION.md).
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const SELECT_COLUMNS = `cp.id, cp.period_year, cp.period_month,
  cp.closed_by, e.name AS closed_by_name, cp.closed_at`;

// e.company_id = cp.company_id on top of the join column itself — the Phase 2
// tenant-isolation rule (SECURITY_AUDIT_TENANT_ISOLATION.md): a read-time JOIN
// on a company_id-scoped table must always carry the tenant match too, not
// just rely on closed_by having been written from the same company at
// insert time.
const FROM_JOIN = `FROM closed_periods cp LEFT JOIN employees e ON e.id = cp.closed_by AND e.company_id = cp.company_id`;

function assertValidPeriod(period_year: unknown, period_month: unknown) {
  if (typeof period_year !== 'number' || !Number.isInteger(period_year) || period_year < MIN_YEAR || period_year > MAX_YEAR) {
    throw new AppError(400, `period_year must be an integer between ${MIN_YEAR} and ${MAX_YEAR}`);
  }
  if (typeof period_month !== 'number' || !Number.isInteger(period_month) || period_month < 1 || period_month > 12) {
    throw new AppError(400, 'period_month must be an integer between 1 and 12');
  }
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE cp.company_id = $1 ORDER BY cp.period_year DESC, cp.period_month DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, closedPeriods: result.rows });
});

export const closePeriod = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { period_year, period_month } = req.body ?? {};
  assertValidPeriod(period_year, period_month);

  // Resolve the caller's own linked employee_id (users.employee_id,
  // MIGRATION_040) to stamp closed_by with the HR-facing identity this table
  // wants (see MIGRATION_053 design decision 1) — deliberately NOT the
  // throwing getOwnEmployeeId() every other controller uses, because an
  // admin/manager without an HR record still has to be able to lock a
  // period. closed_by just comes back NULL in that case.
  const userRow = await pool.query(`SELECT employee_id FROM users WHERE id = $1 AND company_id = $2`, [req.auth!.userId, companyId]);
  const closedBy = userRow.rows[0]?.employee_id ?? null;

  let inserted;
  try {
    inserted = await pool.query(
      `INSERT INTO closed_periods (company_id, closed_by, period_year, period_month)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [companyId, closedBy, period_year, period_month]
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'This period is already closed');
    throw err;
  }

  const result = await pool.query(`SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE cp.id = $1`, [inserted.rows[0].id]);
  const closedPeriod = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'period_closed', entityType: 'closed_periods', entityId: closedPeriod.id, req });

  res.status(201).json({ success: true, closedPeriod });
});

export const reopenPeriod = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query('DELETE FROM closed_periods WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (result.rows.length === 0) throw new AppError(404, 'Closed period not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'period_reopened', entityType: 'closed_periods', entityId: id as string, req });

  res.status(200).json({ success: true });
});
