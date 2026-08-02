import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { consumeRawMaterial, getCurrentPurchasePrice } from '../utils/inventory';
import { UNIT_TO_BASE } from '../utils/costing';

// Task #28 "integrated warehouse management" — ties the FIFO batch system (already
// scoped per-location) into one place a manager can see current stock across every
// location, with a reorder threshold and manual correction path, instead of having
// to infer stock levels by eyeballing the raw batches list.

interface StockRow {
  raw_material_id: string;
  location_id: string;
  qty: number;
}

// Overview: every raw material, its total stock across all locations, a per-location
// breakdown, and a low_stock flag against min_stock_qty (when set). Materials with
// zero stock everywhere still appear — that's the "out of stock" case managers most
// need to see, not something to hide.
export const overview = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;

  const materials = await pool.query(
    `SELECT id, name, name_en, category, package_unit, min_stock_qty
     FROM raw_materials WHERE company_id = $1 ORDER BY name ASC`,
    [companyId]
  );
  const stockRows = await pool.query<StockRow>(
    `SELECT raw_material_id, location_id, SUM(qty_remaining)::float AS qty
     FROM raw_material_batches
     WHERE company_id = $1 AND qty_remaining > 0
     GROUP BY raw_material_id, location_id`,
    [companyId]
  );
  const locations = await pool.query('SELECT id, name, type FROM locations WHERE company_id = $1', [companyId]);
  const locationsById = new Map(locations.rows.map((l) => [l.id, l]));

  const stockByMaterial = new Map<string, StockRow[]>();
  for (const row of stockRows.rows) {
    const list = stockByMaterial.get(row.raw_material_id) ?? [];
    list.push(row);
    stockByMaterial.set(row.raw_material_id, list);
  }

  const result = materials.rows.map((m) => {
    const rows = stockByMaterial.get(m.id) ?? [];
    const byLocation = rows
      .map((r) => {
        const loc = locationsById.get(r.location_id);
        return loc ? { location_id: r.location_id, location_name: loc.name, location_type: loc.type, qty: r.qty } : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    const totalQty = rows.reduce((sum, r) => sum + r.qty, 0);
    const lowStock = m.min_stock_qty !== null && totalQty < Number(m.min_stock_qty);

    return {
      raw_material_id: m.id,
      name: m.name,
      name_en: m.name_en,
      category: m.category,
      package_unit: m.package_unit,
      min_stock_qty: m.min_stock_qty,
      total_qty: totalQty,
      by_location: byLocation,
      low_stock: lowStock,
    };
  });

  res.status(200).json({ success: true, materials: result });
});

export const listAdjustments = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { raw_material_id, location_id } = req.query;

  const params: unknown[] = [companyId];
  let where = 'sa.company_id = $1';
  if (typeof raw_material_id === 'string') {
    params.push(raw_material_id);
    where += ` AND sa.raw_material_id = $${params.length}`;
  }
  if (typeof location_id === 'string') {
    params.push(location_id);
    where += ` AND sa.location_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT sa.id, sa.raw_material_id, sa.location_id, sa.qty_delta, sa.reason, sa.created_at,
            rm.name AS raw_material_name, rm.name_en AS raw_material_name_en,
            l.name AS location_name,
            u.full_name AS created_by_name
     FROM stock_adjustments sa
     JOIN raw_materials rm ON rm.id = sa.raw_material_id
     JOIN locations l ON l.id = sa.location_id
     LEFT JOIN users u ON u.id = sa.created_by
     WHERE ${where}
     ORDER BY sa.created_at DESC
     LIMIT 200`,
    params
  );

  res.status(200).json({ success: true, adjustments: result.rows });
});

// Manual stock correction — for physical counts, spoilage/loss not tied to a sale
// or waste record, or "found" stock. Positive qty_delta opens a new batch (same
// shape a purchase/transfer would create); negative qty_delta consumes FIFO via the
// same consumeRawMaterial() path sales/waste/transfers all use, so it can never take
// a location below zero.
export const adjust = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { raw_material_id, location_id, qty_delta, reason } = req.body ?? {};

  if (typeof raw_material_id !== 'string') throw new AppError(400, 'raw_material_id is required');
  if (typeof location_id !== 'string') throw new AppError(400, 'location_id is required');
  if (typeof qty_delta !== 'number' || qty_delta === 0) throw new AppError(400, 'qty_delta must be a non-zero number');
  if (typeof reason !== 'string' || reason.trim().length < 1) throw new AppError(400, 'reason is required');

  const material = await pool.query('SELECT id, package_unit FROM raw_materials WHERE id = $1 AND company_id = $2', [raw_material_id, companyId]);
  if (!material.rows[0]) throw new AppError(404, 'Raw material not found');
  const unit: string = material.rows[0].package_unit || 'g';
  const location = await pool.query('SELECT id FROM locations WHERE id = $1 AND company_id = $2', [location_id, companyId]);
  if (!location.rows[0]) throw new AppError(404, 'Location not found');

  const client = await pool.connect();
  let adjustment;
  try {
    await client.query('BEGIN');

    let newBatchId: string | null = null;
    if (qty_delta > 0) {
      // qty_delta is entered in the material's own unit (matches every batch — see
      // MIGRATION_027), stored as-is; no base-unit conversion needed for a plain insert.
      const price = await getCurrentPurchasePrice(client, companyId, raw_material_id);
      const batchResult = await client.query(
        `INSERT INTO raw_material_batches (company_id, raw_material_id, location_id, purchase_date, expiry_date, qty_purchased, qty_remaining, purchase_price, unit)
         VALUES ($1, $2, $3, CURRENT_DATE, NULL, $4, $4, $5, $6)
         RETURNING id`,
        [companyId, raw_material_id, location_id, qty_delta, price, unit]
      );
      newBatchId = batchResult.rows[0].id;
    } else {
      // consumeRawMaterial expects base units — convert the entered (native-unit) qty.
      const factor = UNIT_TO_BASE[unit] || 1;
      await consumeRawMaterial(client, companyId, location_id, raw_material_id, Math.abs(qty_delta) * factor);
    }

    const adjResult = await client.query(
      `INSERT INTO stock_adjustments (company_id, raw_material_id, location_id, qty_delta, reason, new_batch_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, raw_material_id, location_id, qty_delta, reason, created_at`,
      [companyId, raw_material_id, location_id, qty_delta, reason.trim(), newBatchId, req.auth!.userId]
    );
    adjustment = adjResult.rows[0];

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'stock_adjusted', entityType: 'stock_adjustments', entityId: adjustment.id, req });

  res.status(201).json({ success: true, adjustment });
});
