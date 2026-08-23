import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

// Per-company, bilingual, tenant-defined categories — the DB-backed
// replacement for supportTickets.controller.ts's hardcoded CATEGORIES /
// HR_CATEGORIES arrays. Those arrays still work (support_tickets.category
// stays live as the legacy fallback — see that file), this table is purely
// additive alongside them for now. Run `node scripts/seed_ticket_categories.js`
// to backfill the 7 legacy categories into this table per company.

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT id, name, name_en, is_hr_sensitive, created_at, updated_at
     FROM ticket_categories WHERE company_id = $1 ORDER BY name`,
    [companyId]
  );
  res.status(200).json({ success: true, categories: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, name_en, is_hr_sensitive } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (name_en !== undefined && name_en !== null && typeof name_en !== 'string') throw new AppError(400, 'name_en must be a string');
  if (is_hr_sensitive !== undefined && typeof is_hr_sensitive !== 'boolean') throw new AppError(400, 'is_hr_sensitive must be a boolean');

  const result = await pool.query(
    `INSERT INTO ticket_categories (company_id, name, name_en, is_hr_sensitive)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, name_en, is_hr_sensitive, created_at, updated_at`,
    [companyId, name.trim(), typeof name_en === 'string' ? name_en.trim() : null, is_hr_sensitive === true]
  );
  const category = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'ticket_category_created', entityType: 'ticket_categories', entityId: category.id, req });

  res.status(201).json({ success: true, category });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { name, name_en, is_hr_sensitive } = req.body ?? {};

  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) throw new AppError(400, 'name must be a non-empty string');
  if (name_en !== undefined && name_en !== null && typeof name_en !== 'string') throw new AppError(400, 'name_en must be a string');
  if (is_hr_sensitive !== undefined && typeof is_hr_sensitive !== 'boolean') throw new AppError(400, 'is_hr_sensitive must be a boolean');

  // Same COALESCE-on-omit pattern documentTemplates.controller.ts uses:
  // omitting a field leaves it untouched. Matches this codebase's existing
  // convention rather than introducing a separate "explicit null" path.
  const result = await pool.query(
    `UPDATE ticket_categories
     SET name = COALESCE($1, name),
         name_en = COALESCE($2, name_en),
         is_hr_sensitive = COALESCE($3, is_hr_sensitive),
         updated_at = NOW()
     WHERE id = $4 AND company_id = $5
     RETURNING id, name, name_en, is_hr_sensitive, created_at, updated_at`,
    [
      typeof name === 'string' ? name.trim() : null,
      typeof name_en === 'string' ? name_en.trim() : null,
      typeof is_hr_sensitive === 'boolean' ? is_hr_sensitive : null,
      id,
      companyId,
    ]
  );
  if (!result.rows[0]) throw new AppError(404, 'Category not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'ticket_category_updated', entityType: 'ticket_categories', entityId: id as string, req });

  res.status(200).json({ success: true, category: result.rows[0] });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  // support_tickets.category_id is ON DELETE SET NULL (MIGRATION_046), so
  // deleting a category never fails on in-use tickets — they just fall back
  // to no category_id (their legacy `category` string, if any, is untouched).
  const result = await pool.query(
    `DELETE FROM ticket_categories WHERE id = $1 AND company_id = $2 RETURNING id`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Category not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'ticket_category_deleted', entityType: 'ticket_categories', entityId: id as string, req });

  res.status(200).json({ success: true });
});
