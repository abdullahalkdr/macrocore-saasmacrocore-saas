import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

// ITSM pivot, Step 2 (MIGRATION_047 built the tables) — the specific
// services under a category (e.g. "Request new software" under
// "Applications"). is_hr_sensitive lives HERE, not on service_categories —
// it's what supportTickets.controller.ts's HR isolation actually reads once
// a ticket carries request_type_id (see that file's visibilityFilter()/
// canAccessTicket()). Same reasoning as MIGRATION_047's own header comment:
// "is this specific service HR-sensitive" is a request-type-level fact.

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { category_id } = req.query;

  const params: unknown[] = [companyId];
  let categoryFilter = '';
  if (typeof category_id === 'string') {
    params.push(category_id);
    categoryFilter = ` AND category_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT id, category_id, name, name_en, description, description_en, is_hr_sensitive, created_at, updated_at
     FROM service_request_types WHERE company_id = $1${categoryFilter} ORDER BY name`,
    params
  );
  res.status(200).json({ success: true, requestTypes: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { category_id, name, name_en, description, description_en, is_hr_sensitive } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (name_en !== undefined && name_en !== null && typeof name_en !== 'string') throw new AppError(400, 'name_en must be a string');
  if (description !== undefined && description !== null && typeof description !== 'string') throw new AppError(400, 'description must be a string');
  if (description_en !== undefined && description_en !== null && typeof description_en !== 'string') throw new AppError(400, 'description_en must be a string');
  if (is_hr_sensitive !== undefined && typeof is_hr_sensitive !== 'boolean') throw new AppError(400, 'is_hr_sensitive must be a boolean');

  // category_id is optional at the schema level (nullable FK) but validated
  // against the caller's own company when present — same cross-tenant check
  // pattern used throughout this codebase (ticket_categories/category_id,
  // etc.) since a plain FK can't enforce "same tenant" across two tables.
  let finalCategoryId: string | null = null;
  if (category_id !== undefined && category_id !== null) {
    if (typeof category_id !== 'string') throw new AppError(400, 'category_id must be a string');
    const catCheck = await pool.query('SELECT id FROM service_categories WHERE id = $1 AND company_id = $2', [category_id, companyId]);
    if (!catCheck.rows[0]) throw new AppError(400, 'category_id does not belong to this company');
    finalCategoryId = category_id;
  }

  const result = await pool.query(
    `INSERT INTO service_request_types (company_id, category_id, name, name_en, description, description_en, is_hr_sensitive)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, category_id, name, name_en, description, description_en, is_hr_sensitive, created_at, updated_at`,
    [
      companyId,
      finalCategoryId,
      name.trim(),
      typeof name_en === 'string' ? name_en.trim() : null,
      typeof description === 'string' ? description.trim() : null,
      typeof description_en === 'string' ? description_en.trim() : null,
      is_hr_sensitive === true,
    ]
  );
  const requestType = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'service_request_type_created', entityType: 'service_request_types', entityId: requestType.id, req });

  res.status(201).json({ success: true, requestType });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { category_id, name, name_en, description, description_en, is_hr_sensitive } = req.body ?? {};

  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) throw new AppError(400, 'name must be a non-empty string');
  if (name_en !== undefined && name_en !== null && typeof name_en !== 'string') throw new AppError(400, 'name_en must be a string');
  if (description !== undefined && description !== null && typeof description !== 'string') throw new AppError(400, 'description must be a string');
  if (description_en !== undefined && description_en !== null && typeof description_en !== 'string') throw new AppError(400, 'description_en must be a string');
  if (is_hr_sensitive !== undefined && typeof is_hr_sensitive !== 'boolean') throw new AppError(400, 'is_hr_sensitive must be a boolean');

  // category_id, unlike the rest of this endpoint's fields, is
  // explicit-null-vs-omitted aware — a request type can be moved to a
  // different category, or detached entirely (null). Same CASE WHEN pattern
  // supportTickets.controller.ts's updateStatus() uses for its own
  // category_id field.
  let touchesCategory = false;
  let nextCategoryId: string | null = null;
  if (category_id !== undefined) {
    touchesCategory = true;
    if (category_id !== null) {
      if (typeof category_id !== 'string') throw new AppError(400, 'category_id must be a string or null');
      const catCheck = await pool.query('SELECT id FROM service_categories WHERE id = $1 AND company_id = $2', [category_id, companyId]);
      if (!catCheck.rows[0]) throw new AppError(400, 'category_id does not belong to this company');
      nextCategoryId = category_id;
    }
  }

  const result = await pool.query(
    `UPDATE service_request_types
     SET category_id = CASE WHEN $1 THEN $2::uuid ELSE category_id END,
         name = COALESCE($3, name),
         name_en = COALESCE($4, name_en),
         description = COALESCE($5, description),
         description_en = COALESCE($6, description_en),
         is_hr_sensitive = COALESCE($7, is_hr_sensitive),
         updated_at = NOW()
     WHERE id = $8 AND company_id = $9
     RETURNING id, category_id, name, name_en, description, description_en, is_hr_sensitive, created_at, updated_at`,
    [
      touchesCategory,
      nextCategoryId,
      typeof name === 'string' ? name.trim() : null,
      typeof name_en === 'string' ? name_en.trim() : null,
      typeof description === 'string' ? description.trim() : null,
      typeof description_en === 'string' ? description_en.trim() : null,
      typeof is_hr_sensitive === 'boolean' ? is_hr_sensitive : null,
      id,
      companyId,
    ]
  );
  if (!result.rows[0]) throw new AppError(404, 'Request type not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'service_request_type_updated', entityType: 'service_request_types', entityId: id as string, req });

  res.status(200).json({ success: true, requestType: result.rows[0] });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  // support_tickets.request_type_id is ON DELETE SET NULL (MIGRATION_047) —
  // same "never take a ticket down with it" behavior as category_id on
  // ticket_categories. service_custom_fields.request_type_id IS a cascade
  // (deleting a request type deletes its custom field definitions).
  const result = await pool.query(
    `DELETE FROM service_request_types WHERE id = $1 AND company_id = $2 RETURNING id`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Request type not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'service_request_type_deleted', entityType: 'service_request_types', entityId: id as string, req });

  res.status(200).json({ success: true });
});
