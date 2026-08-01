import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

const FIELD_TYPES = ['text', 'number', 'date', 'yes_no'];
const APPLIES_TO = ['official_documents', 'company_files', 'employees'];

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT id, name, field_type, applies_to, created_at FROM custom_fields
     WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, custom_fields: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, field_type, applies_to } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 2) throw new AppError(400, 'name is required');
  const finalType = typeof field_type === 'string' && FIELD_TYPES.includes(field_type) ? field_type : 'text';
  const finalAppliesTo = typeof applies_to === 'string' && APPLIES_TO.includes(applies_to) ? applies_to : 'official_documents';

  const result = await pool.query(
    `INSERT INTO custom_fields (company_id, name, field_type, applies_to)
     VALUES ($1, $2, $3, $4) RETURNING id, name, field_type, applies_to, created_at`,
    [companyId, name.trim(), finalType, finalAppliesTo]
  );
  const field = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'custom_field_created', entityType: 'custom_fields', entityId: field.id, req });

  res.status(201).json({ success: true, custom_field: field });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query('DELETE FROM custom_fields WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (!result.rows[0]) throw new AppError(404, 'Custom field not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'custom_field_deleted', entityType: 'custom_fields', entityId: id as string, req });

  res.status(200).json({ success: true, message: 'Custom field deleted' });
});
