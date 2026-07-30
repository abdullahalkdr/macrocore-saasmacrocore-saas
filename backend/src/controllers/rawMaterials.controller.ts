import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT id, name, name_en, category, package_qty, package_unit, purchase_price, supplier_name, created_at
     FROM raw_materials WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, raw_materials: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, name_en, category, package_qty, package_unit, purchase_price, supplier_name } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');

  const result = await pool.query(
    `INSERT INTO raw_materials (company_id, name, name_en, category, package_qty, package_unit, purchase_price, supplier_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, name_en, category, package_qty, package_unit, purchase_price, supplier_name, created_at`,
    [companyId, name.trim(), name_en?.trim() || null, category ?? null, package_qty ?? null, package_unit ?? null, purchase_price ?? null, supplier_name ?? null]
  );
  const rawMaterial = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'raw_material_created', entityType: 'raw_materials', entityId: rawMaterial.id, req });

  res.status(201).json({ success: true, raw_material: rawMaterial });
});
