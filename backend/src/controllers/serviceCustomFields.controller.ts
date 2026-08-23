import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

// ITSM pivot, Step 2 (MIGRATION_047 built the table) — dynamic form
// builder. Per-request-type custom fields whose answers eventually land in
// support_tickets.dynamic_data (JSONB) — see
// supportTickets.controller.ts's create(). This step only defines the
// fields; validating an actual ticket's dynamic_data against them (enforcing
// is_required, per-field_type value checks) is NOT built yet — noted as an
// open item in the ITSM pivot decision log (Claude Project), not dropped
// silently.

const FIELD_TYPES = ['text', 'textarea', 'number', 'dropdown'];

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { request_type_id } = req.query;

  const params: unknown[] = [companyId];
  let filter = '';
  if (typeof request_type_id === 'string') {
    params.push(request_type_id);
    filter = ` AND request_type_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT id, request_type_id, field_key, field_label, field_label_en, field_type, is_required, created_at, updated_at
     FROM service_custom_fields WHERE company_id = $1${filter} ORDER BY created_at ASC`,
    params
  );
  res.status(200).json({ success: true, fields: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { request_type_id, field_key, field_label, field_label_en, field_type, is_required } = req.body ?? {};

  if (typeof request_type_id !== 'string') throw new AppError(400, 'request_type_id is required');
  if (typeof field_key !== 'string' || field_key.trim().length < 1) throw new AppError(400, 'field_key is required');
  if (typeof field_label !== 'string' || field_label.trim().length < 1) throw new AppError(400, 'field_label is required');
  if (field_label_en !== undefined && field_label_en !== null && typeof field_label_en !== 'string') throw new AppError(400, 'field_label_en must be a string');
  if (field_type !== undefined && !FIELD_TYPES.includes(field_type)) throw new AppError(400, `field_type must be one of ${FIELD_TYPES.join(', ')}`);
  if (is_required !== undefined && typeof is_required !== 'boolean') throw new AppError(400, 'is_required must be a boolean');

  // Cross-tenant check — same pattern as every other *_id ownership check
  // introduced across this ITSM pivot and the pre-existing category_id one.
  const rtCheck = await pool.query('SELECT id FROM service_request_types WHERE id = $1 AND company_id = $2', [request_type_id, companyId]);
  if (!rtCheck.rows[0]) throw new AppError(400, 'request_type_id does not belong to this company');

  const result = await pool.query(
    `INSERT INTO service_custom_fields (company_id, request_type_id, field_key, field_label, field_label_en, field_type, is_required)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, request_type_id, field_key, field_label, field_label_en, field_type, is_required, created_at, updated_at`,
    [
      companyId,
      request_type_id,
      field_key.trim(),
      field_label.trim(),
      typeof field_label_en === 'string' ? field_label_en.trim() : null,
      typeof field_type === 'string' ? field_type : 'text',
      is_required === true,
    ]
  );
  const field = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'service_custom_field_created', entityType: 'service_custom_fields', entityId: field.id, req });

  res.status(201).json({ success: true, field });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { field_key, field_label, field_label_en, field_type, is_required } = req.body ?? {};

  if (field_key !== undefined && (typeof field_key !== 'string' || field_key.trim().length < 1)) throw new AppError(400, 'field_key must be a non-empty string');
  if (field_label !== undefined && (typeof field_label !== 'string' || field_label.trim().length < 1)) throw new AppError(400, 'field_label must be a non-empty string');
  if (field_label_en !== undefined && field_label_en !== null && typeof field_label_en !== 'string') throw new AppError(400, 'field_label_en must be a string');
  if (field_type !== undefined && !FIELD_TYPES.includes(field_type)) throw new AppError(400, `field_type must be one of ${FIELD_TYPES.join(', ')}`);
  if (is_required !== undefined && typeof is_required !== 'boolean') throw new AppError(400, 'is_required must be a boolean');

  const result = await pool.query(
    `UPDATE service_custom_fields
     SET field_key = COALESCE($1, field_key),
         field_label = COALESCE($2, field_label),
         field_label_en = COALESCE($3, field_label_en),
         field_type = COALESCE($4, field_type),
         is_required = COALESCE($5, is_required),
         updated_at = NOW()
     WHERE id = $6 AND company_id = $7
     RETURNING id, request_type_id, field_key, field_label, field_label_en, field_type, is_required, created_at, updated_at`,
    [
      typeof field_key === 'string' ? field_key.trim() : null,
      typeof field_label === 'string' ? field_label.trim() : null,
      typeof field_label_en === 'string' ? field_label_en.trim() : null,
      typeof field_type === 'string' ? field_type : null,
      typeof is_required === 'boolean' ? is_required : null,
      id,
      companyId,
    ]
  );
  if (!result.rows[0]) throw new AppError(404, 'Field not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'service_custom_field_updated', entityType: 'service_custom_fields', entityId: id as string, req });

  res.status(200).json({ success: true, field: result.rows[0] });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query(
    `DELETE FROM service_custom_fields WHERE id = $1 AND company_id = $2 RETURNING id`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Field not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'service_custom_field_deleted', entityType: 'service_custom_fields', entityId: id as string, req });

  res.status(200).json({ success: true });
});
