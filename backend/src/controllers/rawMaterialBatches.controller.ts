/**
 * Raw Material Batches Controller
 * FIFO inventory management at the batch level.
 */

import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { getBatchesForMaterial, getExpiringBatches } from '../utils/inventory';

/**
 * POST /api/raw-material-batches
 * Create a new batch for a raw material (supplier received a shipment).
 */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { raw_material_id, location_id, purchase_date, expiry_date, qty_purchased, purchase_price } = req.body ?? {};

  if (typeof raw_material_id !== 'string') throw new AppError(400, 'raw_material_id is required');
  if (typeof location_id !== 'string') throw new AppError(400, 'location_id is required');
  if (typeof purchase_date !== 'string') throw new AppError(400, 'purchase_date is required (DATE format: YYYY-MM-DD)');
  if (typeof qty_purchased !== 'number' || qty_purchased <= 0) throw new AppError(400, 'qty_purchased must be a positive number');
  if (typeof purchase_price !== 'number' || purchase_price < 0) throw new AppError(400, 'purchase_price must be a non-negative number');

  // Verify raw material exists — also pulls package_unit, which becomes this batch's
  // unit (see MIGRATION_027: one unit per material, never chosen per-batch, so it
  // always matches what the Inventory Overview page displays and what consumeRawMaterial
  // expects).
  const matResult = await pool.query(
    `SELECT id, package_unit FROM raw_materials WHERE id = $1 AND company_id = $2`,
    [raw_material_id, companyId]
  );
  if (!matResult.rows[0]) throw new AppError(404, 'Raw material not found');
  const unit: string = matResult.rows[0].package_unit || 'g';

  // Verify location exists
  const locResult = await pool.query(`SELECT id FROM locations WHERE id = $1 AND company_id = $2`, [location_id, companyId]);
  if (!locResult.rows[0]) throw new AppError(404, 'Location not found');

  const result = await pool.query(
    `INSERT INTO raw_material_batches (company_id, raw_material_id, location_id, purchase_date, expiry_date, qty_purchased, qty_remaining, purchase_price, unit)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)
     RETURNING id, raw_material_id, location_id, purchase_date, expiry_date, qty_purchased, qty_remaining, purchase_price, unit, created_at`,
    [companyId, raw_material_id, location_id, purchase_date, expiry_date ?? null, qty_purchased, purchase_price, unit]
  );

  const batch = result.rows[0];
  await logAudit({ companyId, userId: req.auth!.userId, action: 'batch_created', entityType: 'raw_material_batches', entityId: batch.id, req });

  res.status(201).json({ success: true, batch });
});

/**
 * GET /api/raw-material-batches
 * List all batches (optionally filtered by material).
 */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { raw_material_id, location_id } = req.query;

  const params: unknown[] = [companyId];
  let where = 'company_id = $1';

  if (typeof raw_material_id === 'string') {
    params.push(raw_material_id);
    where += ` AND raw_material_id = $${params.length}`;
  }
  if (typeof location_id === 'string') {
    params.push(location_id);
    where += ` AND location_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT id, raw_material_id, location_id, purchase_date, expiry_date, qty_purchased, qty_remaining, purchase_price, unit,
            COALESCE(expiry_date::date - CURRENT_DATE, NULL) AS days_until_expiry,
            created_at
     FROM raw_material_batches
     WHERE ${where}
     ORDER BY
       CASE WHEN expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE THEN 0 ELSE 1 END,
       expiry_date ASC NULLS LAST,
       purchase_date ASC`,
    params
  );

  res.status(200).json({ success: true, batches: result.rows });
});

/**
 * GET /api/raw-material-batches/:id
 * Get a single batch.
 */
export const getById = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query(
    `SELECT id, raw_material_id, location_id, purchase_date, expiry_date, qty_purchased, qty_remaining, purchase_price, unit,
            COALESCE(expiry_date::date - CURRENT_DATE, NULL) AS days_until_expiry,
            created_at, updated_at
     FROM raw_material_batches
     WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );

  if (!result.rows[0]) throw new AppError(404, 'Batch not found');

  res.status(200).json({ success: true, batch: result.rows[0] });
});

/**
 * PATCH /api/raw-material-batches/:id
 * Update a batch (primarily expiry_date). Cannot modify qty_*, price, or location after creation
 * (moving inventory between locations goes through POST /api/stock-transfers instead).
 */
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { expiry_date } = req.body ?? {};

  if (typeof expiry_date !== 'string') throw new AppError(400, 'expiry_date is required (DATE format: YYYY-MM-DD)');

  const result = await pool.query(
    `UPDATE raw_material_batches
     SET expiry_date = $1, updated_at = NOW()
     WHERE id = $2 AND company_id = $3
     RETURNING id, raw_material_id, location_id, purchase_date, expiry_date, qty_purchased, qty_remaining, purchase_price, updated_at`,
    [expiry_date, id, companyId]
  );

  if (!result.rows[0]) throw new AppError(404, 'Batch not found');

  const batch = result.rows[0];
  await logAudit({ companyId, userId: req.auth!.userId, action: 'batch_updated', entityType: 'raw_material_batches', entityId: batch.id, req });

  res.status(200).json({ success: true, batch });
});

/**
 * DELETE /api/raw-material-batches/:id
 * Soft delete by setting qty_remaining to 0 (or hard delete if qty_remaining is already 0).
 */
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query(
    `SELECT id, qty_remaining FROM raw_material_batches WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );

  if (!result.rows[0]) throw new AppError(404, 'Batch not found');

  const batch = result.rows[0];
  if (batch.qty_remaining > 0) {
    throw new AppError(400, 'Cannot delete a batch with remaining quantity. Try consuming or adjusting qty_remaining first.');
  }

  await pool.query(`DELETE FROM raw_material_batches WHERE id = $1`, [id]);

  await logAudit({ companyId, userId: req.auth!.userId, action: 'batch_deleted', entityType: 'raw_material_batches', entityId: id, req });

  res.status(200).json({ success: true, message: 'Batch deleted' });
});

/**
 * GET /api/raw-material-batches/expiring/list
 * Get all batches expiring within a threshold (default 30 days).
 * Used for alerts in the frontend.
 */
export const getExpiring = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const days = parseInt(String(req.query.days ?? '30'), 10) || 30;

  const client = await pool.connect();
  try {
    const batches = await getExpiringBatches(client, companyId, days);
    res.status(200).json({ success: true, batches });
  } finally {
    client.release();
  }
});
