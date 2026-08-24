import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { isForeignKeyViolation, isUniqueViolation } from '../utils/dbErrors';

// Cost Centers module (MIGRATION_051) — a dedicated registry for the codes that
// locations.cost_center_code (MIGRATION_050) and departments.cost_center_code
// (MIGRATION_049) have so far only stored as free-text tags. Same shape as
// locations.controller.ts: company-scoped CRUD, an optional manager (an
// employees row), strict read-time company_id JOIN matching per the tenant
// isolation audit (SECURITY_AUDIT_TENANT_ISOLATION.md).
const STATUSES = ['active', 'inactive'];

const SELECT_COLUMNS = `cc.id, cc.code, cc.name, cc.description, cc.manager_id, m.name AS manager_name,
  cc.status, cc.created_at, cc.updated_at`;

const FROM_JOIN = `FROM cost_centers cc LEFT JOIN employees m ON m.id = cc.manager_id AND m.company_id = cc.company_id`;

// Shared by create() and update() — manager_id must be a real employees row in
// the same company, same cross-tenant-validation shape locations.controller.ts's
// assertManagerInCompany already uses.
async function assertManagerInCompany(managerId: unknown, companyId: string) {
  if (!managerId) return;
  const emp = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [managerId, companyId]);
  if (emp.rows.length === 0) throw new AppError(400, 'manager_id not found');
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE cc.company_id = $1 ORDER BY cc.code`,
    [companyId]
  );
  res.status(200).json({ success: true, costCenters: result.rows });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE cc.id = $1 AND cc.company_id = $2`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Cost center not found');
  res.status(200).json({ success: true, costCenter: result.rows[0] });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { code, name, description, manager_id, status } = req.body ?? {};

  if (typeof code !== 'string' || code.trim().length < 1) throw new AppError(400, 'code is required');
  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (status !== undefined && !STATUSES.includes(status)) throw new AppError(400, `status must be one of ${STATUSES.join(', ')}`);
  await assertManagerInCompany(manager_id, companyId);

  let inserted;
  try {
    inserted = await pool.query(
      `INSERT INTO cost_centers (company_id, code, name, description, manager_id, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [companyId, code.trim(), name.trim(), description ?? null, manager_id ?? null, status || 'active']
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'A cost center with this code already exists');
    throw err;
  }

  // Re-select through the same SELECT_COLUMNS/JOIN as list() so the response carries
  // manager_name too, not a partial row — same pattern locations.controller.ts's
  // create() uses.
  const result = await pool.query(`SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE cc.id = $1`, [inserted.rows[0].id]);
  const costCenter = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'cost_center_created', entityType: 'cost_centers', entityId: costCenter.id, req });

  res.status(201).json({ success: true, costCenter });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { code, name, description, manager_id, status } = req.body ?? {};

  if (code !== undefined && (typeof code !== 'string' || code.trim().length < 1)) {
    throw new AppError(400, 'code must be a non-empty string when provided');
  }
  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) {
    throw new AppError(400, 'name must be a non-empty string when provided');
  }
  if (status !== undefined && !STATUSES.includes(status)) throw new AppError(400, `status must be one of ${STATUSES.join(', ')}`);
  if (manager_id !== undefined) await assertManagerInCompany(manager_id, companyId);

  const existing = await pool.query(
    `SELECT id, code, name, description, manager_id, status FROM cost_centers WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!existing.rows[0]) throw new AppError(404, 'Cost center not found');
  const current = existing.rows[0];

  try {
    await pool.query(
      `UPDATE cost_centers SET
         code = $1, name = $2, description = $3, manager_id = $4, status = $5,
         updated_at = NOW()
       WHERE id = $6 AND company_id = $7`,
      [
        code !== undefined ? code.trim() : current.code,
        name !== undefined ? name.trim() : current.name,
        description !== undefined ? description : current.description,
        manager_id !== undefined ? (manager_id || null) : current.manager_id,
        status !== undefined ? status : current.status,
        id,
        companyId,
      ]
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'A cost center with this code already exists');
    throw err;
  }

  const result = await pool.query(`SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE cc.id = $1`, [id]);
  const costCenter = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'cost_center_updated', entityType: 'cost_centers', entityId: costCenter.id, req });

  res.status(200).json({ success: true, costCenter });
});

// No FK from another table points at cost_centers today (locations/departments
// still carry their own free-text cost_center_code, see MIGRATION_051's decision
// 4), so this delete can't actually be blocked by isForeignKeyViolation right
// now — kept anyway so a future FK against this table (should one ever be
// added) fails safely with a 409 instead of an unhandled 500, same defensive
// shape locations.controller.ts's remove() uses.
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM cost_centers WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
    if (result.rows.length === 0) throw new AppError(404, 'Cost center not found');
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new AppError(409, 'This cost center is in use and cannot be deleted');
    }
    throw err;
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'cost_center_deleted', entityType: 'cost_centers', entityId: id as string, req });

  res.status(200).json({ success: true });
});
