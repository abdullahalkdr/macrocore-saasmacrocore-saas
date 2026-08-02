import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { isForeignKeyViolation } from '../utils/dbErrors';

const SELECT_COLUMNS =
  'id, name, name_en, category, package_qty, package_unit, purchase_price, supplier_name, supplier_id, min_stock_qty, created_at';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT rm.id, rm.name, rm.name_en, rm.category, rm.package_qty, rm.package_unit, rm.purchase_price,
            rm.supplier_name, rm.supplier_id, s.name AS supplier_display_name, rm.min_stock_qty, rm.created_at
     FROM raw_materials rm
     LEFT JOIN suppliers s ON s.id = rm.supplier_id
     WHERE rm.company_id = $1 ORDER BY rm.created_at DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, raw_materials: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, name_en, category, package_qty, package_unit, purchase_price, supplier_name, supplier_id, min_stock_qty } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (supplier_id) {
    const sup = await pool.query('SELECT id FROM suppliers WHERE id = $1 AND company_id = $2', [supplier_id, companyId]);
    if (sup.rows.length === 0) throw new AppError(400, 'supplier_id not found');
  }

  const result = await pool.query(
    `INSERT INTO raw_materials (company_id, name, name_en, category, package_qty, package_unit, purchase_price, supplier_name, supplier_id, min_stock_qty)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${SELECT_COLUMNS}`,
    [
      companyId,
      name.trim(),
      name_en?.trim() || null,
      category ?? null,
      package_qty ?? null,
      package_unit ?? null,
      purchase_price ?? null,
      supplier_name ?? null,
      supplier_id ?? null,
      min_stock_qty ?? null,
    ]
  );
  const rawMaterial = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'raw_material_created', entityType: 'raw_materials', entityId: rawMaterial.id, req });

  res.status(201).json({ success: true, raw_material: rawMaterial });
});

// Every field optional — same pattern as employees.controller.ts's update(). Needed
// so an existing raw material can get a reorder threshold (min_stock_qty) set/changed
// without recreating it.
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { name, name_en, category, package_qty, package_unit, purchase_price, supplier_name, supplier_id, min_stock_qty } = req.body ?? {};

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const setField = (column: string, value: unknown) => {
    sets.push(`${column} = $${i++}`);
    values.push(value);
  };

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name must be a non-empty string');
    setField('name', name.trim());
  }
  if (name_en !== undefined) setField('name_en', name_en?.trim() || null);
  if (category !== undefined) setField('category', category || null);
  if (package_qty !== undefined) setField('package_qty', package_qty);
  if (package_unit !== undefined) setField('package_unit', package_unit || null);
  if (purchase_price !== undefined) setField('purchase_price', purchase_price);
  if (supplier_name !== undefined) setField('supplier_name', supplier_name || null);
  if (supplier_id !== undefined) {
    if (supplier_id) {
      const sup = await pool.query('SELECT id FROM suppliers WHERE id = $1 AND company_id = $2', [supplier_id, companyId]);
      if (sup.rows.length === 0) throw new AppError(400, 'supplier_id not found');
    }
    setField('supplier_id', supplier_id || null);
  }
  if (min_stock_qty !== undefined) setField('min_stock_qty', min_stock_qty);

  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push('updated_at = NOW()');
  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE raw_materials SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i}
     RETURNING ${SELECT_COLUMNS}`,
    values
  );
  const rawMaterial = result.rows[0];
  if (!rawMaterial) throw new AppError(404, 'Raw material not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'raw_material_updated', entityType: 'raw_materials', entityId: id as string, req });

  res.status(200).json({ success: true, raw_material: rawMaterial });
});

// Admin/manager only (see routes). raw_material_batches cascades away with the
// material (its own inventory history), but product_ingredients/product_size_ingredients
// (any recipe using it) and stock_transfers do NOT cascade — blocked by a FK violation,
// caught below, if this material is used in a product recipe or has transfer history.
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM raw_materials WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
    if (result.rows.length === 0) throw new AppError(404, 'Raw material not found');
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new AppError(409, 'This raw material is used in a product recipe or has transfer history and cannot be deleted — remove it from recipes first');
    }
    throw err;
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'raw_material_deleted', entityType: 'raw_materials', entityId: id as string, req });

  res.status(200).json({ success: true });
});
