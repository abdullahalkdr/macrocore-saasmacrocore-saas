import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { isForeignKeyViolation, isUniqueViolation } from '../utils/dbErrors';

// Projects module (MIGRATION_052) — the tier above Cost Centers (MIGRATION_051):
// a project consumes budget and optionally rolls up to a cost center. Same
// shape as costCenters.controller.ts: company-scoped CRUD, two optional FKs
// (manager_id -> employees, cost_center_id -> cost_centers), strict read-time
// company_id JOIN matching on both per the tenant isolation audit
// (SECURITY_AUDIT_TENANT_ISOLATION.md).
const STATUSES = ['active', 'completed', 'on_hold', 'cancelled'];

const SELECT_COLUMNS = `p.id, p.code, p.name, p.description,
  p.manager_id, m.name AS manager_name,
  p.cost_center_id, cc.code AS cost_center_code, cc.name AS cost_center_name,
  p.start_date, p.end_date, p.budget, p.status, p.created_at, p.updated_at`;

const FROM_JOIN = `FROM projects p
  LEFT JOIN employees m ON m.id = p.manager_id AND m.company_id = p.company_id
  LEFT JOIN cost_centers cc ON cc.id = p.cost_center_id AND cc.company_id = p.company_id`;

// Shared by create() and update() — manager_id must be a real employees row in
// the same company, same cross-tenant-validation shape locations.controller.ts's
// assertManagerInCompany already uses.
async function assertManagerInCompany(managerId: unknown, companyId: string) {
  if (!managerId) return;
  const emp = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [managerId, companyId]);
  if (emp.rows.length === 0) throw new AppError(400, 'manager_id not found');
}

// Same write-time cross-tenant check, this time against cost_centers — a
// client-supplied cost_center_id must be a real row in the same company
// before it's ever allowed into an INSERT/UPDATE.
async function assertCostCenterInCompany(costCenterId: unknown, companyId: string) {
  if (!costCenterId) return;
  const cc = await pool.query('SELECT id FROM cost_centers WHERE id = $1 AND company_id = $2', [costCenterId, companyId]);
  if (cc.rows.length === 0) throw new AppError(400, 'cost_center_id not found');
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE p.company_id = $1 ORDER BY p.created_at DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, projects: result.rows });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE p.id = $1 AND p.company_id = $2`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Project not found');
  res.status(200).json({ success: true, project: result.rows[0] });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { code, name, description, manager_id, cost_center_id, start_date, end_date, budget, status } = req.body ?? {};

  if (typeof code !== 'string' || code.trim().length < 1) throw new AppError(400, 'code is required');
  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (typeof start_date !== 'string' || start_date.trim().length < 1) throw new AppError(400, 'start_date is required');
  if (budget !== undefined && (typeof budget !== 'number' || budget < 0)) throw new AppError(400, 'budget must be a non-negative number');
  if (status !== undefined && !STATUSES.includes(status)) throw new AppError(400, `status must be one of ${STATUSES.join(', ')}`);
  await assertManagerInCompany(manager_id, companyId);
  await assertCostCenterInCompany(cost_center_id, companyId);

  let inserted;
  try {
    inserted = await pool.query(
      `INSERT INTO projects (company_id, code, name, description, manager_id, cost_center_id, start_date, end_date, budget, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        companyId,
        code.trim(),
        name.trim(),
        description ?? null,
        manager_id ?? null,
        cost_center_id ?? null,
        start_date,
        end_date || null,
        budget ?? 0,
        status || 'active',
      ]
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'A project with this code already exists');
    throw err;
  }

  // Re-select through the same SELECT_COLUMNS/JOIN as list() so the response carries
  // manager_name/cost_center_name too, not a partial row — same pattern
  // costCenters.controller.ts's create() uses.
  const result = await pool.query(`SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE p.id = $1`, [inserted.rows[0].id]);
  const project = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'project_created', entityType: 'projects', entityId: project.id, req });

  res.status(201).json({ success: true, project });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { code, name, description, manager_id, cost_center_id, start_date, end_date, budget, status } = req.body ?? {};

  if (code !== undefined && (typeof code !== 'string' || code.trim().length < 1)) {
    throw new AppError(400, 'code must be a non-empty string when provided');
  }
  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) {
    throw new AppError(400, 'name must be a non-empty string when provided');
  }
  if (start_date !== undefined && (typeof start_date !== 'string' || start_date.trim().length < 1)) {
    throw new AppError(400, 'start_date must be a non-empty string when provided');
  }
  if (budget !== undefined && (typeof budget !== 'number' || budget < 0)) throw new AppError(400, 'budget must be a non-negative number');
  if (status !== undefined && !STATUSES.includes(status)) throw new AppError(400, `status must be one of ${STATUSES.join(', ')}`);
  if (manager_id !== undefined) await assertManagerInCompany(manager_id, companyId);
  if (cost_center_id !== undefined) await assertCostCenterInCompany(cost_center_id, companyId);

  const existing = await pool.query(
    `SELECT id, code, name, description, manager_id, cost_center_id, start_date, end_date, budget, status
     FROM projects WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!existing.rows[0]) throw new AppError(404, 'Project not found');
  const current = existing.rows[0];

  try {
    await pool.query(
      `UPDATE projects SET
         code = $1, name = $2, description = $3, manager_id = $4, cost_center_id = $5,
         start_date = $6, end_date = $7, budget = $8, status = $9,
         updated_at = NOW()
       WHERE id = $10 AND company_id = $11`,
      [
        code !== undefined ? code.trim() : current.code,
        name !== undefined ? name.trim() : current.name,
        description !== undefined ? description : current.description,
        manager_id !== undefined ? (manager_id || null) : current.manager_id,
        cost_center_id !== undefined ? (cost_center_id || null) : current.cost_center_id,
        start_date !== undefined ? start_date : current.start_date,
        end_date !== undefined ? (end_date || null) : current.end_date,
        budget !== undefined ? budget : current.budget,
        status !== undefined ? status : current.status,
        id,
        companyId,
      ]
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'A project with this code already exists');
    throw err;
  }

  const result = await pool.query(`SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE p.id = $1`, [id]);
  const project = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'project_updated', entityType: 'projects', entityId: project.id, req });

  res.status(200).json({ success: true, project });
});

// No FK from another table points at projects today, so this delete can't
// actually be blocked by isForeignKeyViolation right now — kept anyway so a
// future FK against this table (e.g. time entries, purchase orders tagged to
// a project) fails safely with a 409 instead of an unhandled 500, same
// defensive shape locations.controller.ts's/costCenters.controller.ts's
// remove() use.
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM projects WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
    if (result.rows.length === 0) throw new AppError(404, 'Project not found');
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new AppError(409, 'This project is in use and cannot be deleted');
    }
    throw err;
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'project_deleted', entityType: 'projects', entityId: id as string, req });

  res.status(200).json({ success: true });
});
