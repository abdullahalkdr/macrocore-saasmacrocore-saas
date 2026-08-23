import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

// ITSM pivot, Step 2 (MIGRATION_047 built the tables) — the portal home.
// Per-company, bilingual broad groupings a company sets up once (e.g.
// "Computers", "Logins and Accounts", "Applications"). Mirrors
// ticketCategories.controller.ts's shape/conventions exactly — same split
// of GET (any authenticated role) vs POST/PUT/DELETE (admin/manager).
//
// Note: deleting a category CASCADEs to every service_request_types row
// under it (MIGRATION_047's FK), and from there to their
// service_custom_fields rows too — unlike ticket_categories, where deleting
// a category only detaches tickets (ON DELETE SET NULL). remove() below
// doesn't warn about this itself; the frontend is expected to confirm
// before calling DELETE, same as it already does for ticket_categories.

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT id, name, name_en, description, description_en, icon, created_at, updated_at
     FROM service_categories WHERE company_id = $1 ORDER BY name`,
    [companyId]
  );
  res.status(200).json({ success: true, categories: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, name_en, description, description_en, icon } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (name_en !== undefined && name_en !== null && typeof name_en !== 'string') throw new AppError(400, 'name_en must be a string');
  if (description !== undefined && description !== null && typeof description !== 'string') throw new AppError(400, 'description must be a string');
  if (description_en !== undefined && description_en !== null && typeof description_en !== 'string') throw new AppError(400, 'description_en must be a string');
  if (icon !== undefined && icon !== null && typeof icon !== 'string') throw new AppError(400, 'icon must be a string');

  const result = await pool.query(
    `INSERT INTO service_categories (company_id, name, name_en, description, description_en, icon)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, name_en, description, description_en, icon, created_at, updated_at`,
    [
      companyId,
      name.trim(),
      typeof name_en === 'string' ? name_en.trim() : null,
      typeof description === 'string' ? description.trim() : null,
      typeof description_en === 'string' ? description_en.trim() : null,
      typeof icon === 'string' ? icon.trim() : null,
    ]
  );
  const category = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'service_category_created', entityType: 'service_categories', entityId: category.id, req });

  res.status(201).json({ success: true, category });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { name, name_en, description, description_en, icon } = req.body ?? {};

  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) throw new AppError(400, 'name must be a non-empty string');
  if (name_en !== undefined && name_en !== null && typeof name_en !== 'string') throw new AppError(400, 'name_en must be a string');
  if (description !== undefined && description !== null && typeof description !== 'string') throw new AppError(400, 'description must be a string');
  if (description_en !== undefined && description_en !== null && typeof description_en !== 'string') throw new AppError(400, 'description_en must be a string');
  if (icon !== undefined && icon !== null && typeof icon !== 'string') throw new AppError(400, 'icon must be a string');

  const result = await pool.query(
    `UPDATE service_categories
     SET name = COALESCE($1, name),
         name_en = COALESCE($2, name_en),
         description = COALESCE($3, description),
         description_en = COALESCE($4, description_en),
         icon = COALESCE($5, icon),
         updated_at = NOW()
     WHERE id = $6 AND company_id = $7
     RETURNING id, name, name_en, description, description_en, icon, created_at, updated_at`,
    [
      typeof name === 'string' ? name.trim() : null,
      typeof name_en === 'string' ? name_en.trim() : null,
      typeof description === 'string' ? description.trim() : null,
      typeof description_en === 'string' ? description_en.trim() : null,
      typeof icon === 'string' ? icon.trim() : null,
      id,
      companyId,
    ]
  );
  if (!result.rows[0]) throw new AppError(404, 'Category not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'service_category_updated', entityType: 'service_categories', entityId: id as string, req });

  res.status(200).json({ success: true, category: result.rows[0] });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query(
    `DELETE FROM service_categories WHERE id = $1 AND company_id = $2 RETURNING id`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Category not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'service_category_deleted', entityType: 'service_categories', entityId: id as string, req });

  res.status(200).json({ success: true });
});
