import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

// Dynamic, per-company corporate departments (MIGRATION_048). Mirrors
// serviceCategories.controller.ts's shape/conventions exactly — GET open to
// any authenticated role (an employee's own department shows up in the
// support ticket assignee list, and any employee filling out their own
// profile may need to read the list), POST/PUT/DELETE admin/manager only.
//
// Unlike service_categories -> service_request_types, deleting a department
// does NOT cascade — employees.department_id is ON DELETE SET NULL (see the
// migration's decision 4), so remove() below is a plain delete, no warning
// about orphaned child rows needed.

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT id, name, name_en, created_at, updated_at FROM departments WHERE company_id = $1 ORDER BY name`,
    [companyId]
  );
  res.status(200).json({ success: true, departments: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, name_en } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (typeof name_en !== 'string' || name_en.trim().length < 1) throw new AppError(400, 'name_en is required');

  const result = await pool.query(
    `INSERT INTO departments (company_id, name, name_en) VALUES ($1, $2, $3)
     RETURNING id, name, name_en, created_at, updated_at`,
    [companyId, name.trim(), name_en.trim()]
  );
  const department = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'department_created', entityType: 'departments', entityId: department.id, req });

  res.status(201).json({ success: true, department });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { name, name_en } = req.body ?? {};

  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) throw new AppError(400, 'name must be a non-empty string');
  if (name_en !== undefined && (typeof name_en !== 'string' || name_en.trim().length < 1)) throw new AppError(400, 'name_en must be a non-empty string');

  const result = await pool.query(
    `UPDATE departments
     SET name = COALESCE($1, name), name_en = COALESCE($2, name_en), updated_at = NOW()
     WHERE id = $3 AND company_id = $4
     RETURNING id, name, name_en, created_at, updated_at`,
    [typeof name === 'string' ? name.trim() : null, typeof name_en === 'string' ? name_en.trim() : null, id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Department not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'department_updated', entityType: 'departments', entityId: id as string, req });

  res.status(200).json({ success: true, department: result.rows[0] });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query(`DELETE FROM departments WHERE id = $1 AND company_id = $2 RETURNING id`, [id, companyId]);
  if (!result.rows[0]) throw new AppError(404, 'Department not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'department_deleted', entityType: 'departments', entityId: id as string, req });

  res.status(200).json({ success: true });
});
