import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { consumeRawMaterial } from '../utils/inventory';
import { UNIT_TO_BASE } from '../utils/costing';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { shift_id } = req.query;

  const params: unknown[] = [companyId];
  let where = 'company_id = $1';
  if (typeof shift_id === 'string') {
    params.push(shift_id);
    where += ` AND shift_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT id, shift_id, product_id, qty, created_at FROM waste_records WHERE ${where} ORDER BY created_at DESC`,
    params
  );
  res.status(200).json({ success: true, waste_records: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { shift_id, product_id, qty, image_base64 } = req.body ?? {};

  if (typeof shift_id !== 'string') throw new AppError(400, 'shift_id is required');
  if (typeof product_id !== 'string') throw new AppError(400, 'product_id is required');
  if (typeof qty !== 'number' || qty <= 0) throw new AppError(400, 'qty must be a positive number');

  // shift_id has no company FK by itself — check it belongs to this company before writing.
  const shift = await pool.query('SELECT id, location_id FROM shifts WHERE id = $1 AND company_id = $2', [shift_id, companyId]);
  if (!shift.rows[0]) throw new AppError(404, 'Shift not found');
  const locationId: string | null = shift.rows[0].location_id;
  if (!locationId) throw new AppError(400, 'Shift has no location — cannot determine which inventory to consume from');

  // Transactional: consume raw materials from batches, then record waste
  const client = await pool.connect();
  let wasteRecord;
  try {
    await client.query('BEGIN');

    // Get product ingredients and consume from batches
    const ingredientsResult = await client.query(
      `SELECT pi.raw_material_id, pi.usage_qty, pi.usage_unit
       FROM product_ingredients pi
       WHERE pi.product_id = $1`,
      [product_id]
    );

    for (const ingredient of ingredientsResult.rows) {
      const factor = ingredient.usage_unit ? UNIT_TO_BASE[ingredient.usage_unit] || 1 : 1;
      const qtyToConsume = (ingredient.usage_qty || 0) * (factor ?? 1) * qty;

      if (qtyToConsume > 0) {
        try {
          await consumeRawMaterial(client, companyId, locationId, ingredient.raw_material_id, qtyToConsume);
        } catch (err) {
          throw new AppError(
            400,
            `Cannot record waste: insufficient raw material inventory at this location. ${(err as any).message || 'Check inventory levels.'}`
          );
        }
      }
    }

    // Record waste
    const result = await client.query(
      `INSERT INTO waste_records (company_id, shift_id, product_id, qty, image_base64)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, shift_id, product_id, qty, created_at`,
      [companyId, shift_id, product_id, qty, image_base64 ?? null]
    );
    wasteRecord = result.rows[0];

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'waste_recorded', entityType: 'waste_records', entityId: wasteRecord.id, req });

  res.status(201).json({ success: true, waste_record: wasteRecord });
});
