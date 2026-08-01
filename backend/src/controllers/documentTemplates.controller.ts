import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

// One default template per company for now (is_default always true) — the
// styling applied when generating official documents/PDFs. Multiple named
// templates can come later; today this is a single upsert-style row.
export const getDefault = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT id, name, logo_base64, primary_color, footer_text, show_stamp, created_at, updated_at
     FROM document_templates WHERE company_id = $1 AND is_default = true`,
    [companyId]
  );
  res.status(200).json({ success: true, template: result.rows[0] ?? null });
});

export const upsertDefault = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, logo_base64, primary_color, footer_text, show_stamp } = req.body ?? {};

  if (primary_color !== undefined && (typeof primary_color !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(primary_color))) {
    throw new AppError(400, 'primary_color must be a hex color like #f59e0b');
  }
  if (show_stamp !== undefined && typeof show_stamp !== 'boolean') throw new AppError(400, 'show_stamp must be a boolean');

  const result = await pool.query(
    `INSERT INTO document_templates (company_id, name, logo_base64, primary_color, footer_text, show_stamp, is_default)
     VALUES ($1, COALESCE($2, 'الافتراضي'), $3, COALESCE($4, '#f59e0b'), $5, COALESCE($6, false), true)
     ON CONFLICT (company_id) WHERE is_default = true
     DO UPDATE SET
       name = COALESCE($2, document_templates.name),
       logo_base64 = COALESCE($3, document_templates.logo_base64),
       primary_color = COALESCE($4, document_templates.primary_color),
       footer_text = COALESCE($5, document_templates.footer_text),
       show_stamp = COALESCE($6, document_templates.show_stamp),
       updated_at = NOW()
     RETURNING id, name, logo_base64, primary_color, footer_text, show_stamp, created_at, updated_at`,
    [
      companyId,
      typeof name === 'string' ? name : null,
      typeof logo_base64 === 'string' ? logo_base64 : null,
      typeof primary_color === 'string' ? primary_color : null,
      typeof footer_text === 'string' ? footer_text : null,
      typeof show_stamp === 'boolean' ? show_stamp : null,
    ]
  );
  const template = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'document_template_updated', entityType: 'document_templates', entityId: template.id, req });

  res.status(200).json({ success: true, template });
});
