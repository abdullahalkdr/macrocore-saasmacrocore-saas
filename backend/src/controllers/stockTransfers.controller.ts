/**
 * Stock Transfers Controller
 * Moves raw material inventory between two locations (typically warehouse -> kiosk).
 * See docs/MIGRATION_006_location_inventory.sql and src/utils/inventory.ts (transferStock).
 */

import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { transferStock } from '../utils/inventory';

/**
 * POST /api/stock-transfers
 * Transfer qty of a raw material from one location to another.
 * Consumes FIFO from the source location's batches, creates one new batch at the destination.
 */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { raw_material_id, from_location_id, to_location_id, qty } = req.body ?? {};

  if (typeof raw_material_id !== 'string') throw new AppError(400, 'raw_material_id is required');
  if (typeof from_location_id !== 'string') throw new AppError(400, 'from_location_id is required');
  if (typeof to_location_id !== 'string') throw new AppError(400, 'to_location_id is required');
  if (typeof qty !== 'number' || qty <= 0) throw new AppError(400, 'qty must be a positive number');
  if (from_location_id === to_location_id) throw new AppError(400, 'from_location_id and to_location_id must be different');

  // Verify both locations belong to this company
  const locResult = await pool.query(
    `SELECT id FROM locations WHERE company_id = $1 AND id IN ($2, $3)`,
    [companyId, from_location_id, to_location_id]
  );
  if (locResult.rows.length !== 2) throw new AppError(404, 'One or both locations were not found');

  // Verify raw material belongs to this company
  const matResult = await pool.query(`SELECT id FROM raw_materials WHERE id = $1 AND company_id = $2`, [raw_material_id, companyId]);
  if (!matResult.rows[0]) throw new AppError(404, 'Raw material not found');

  const client = await pool.connect();
  let transfer;
  try {
    await client.query('BEGIN');

    const { newBatchId, avgCostPerUnit } = await transferStock(client, companyId, raw_material_id, from_location_id, to_location_id, qty);

    const transferResult = await client.query(
      `INSERT INTO stock_transfers (company_id, raw_material_id, from_location_id, to_location_id, qty, new_batch_id, transferred_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, raw_material_id, from_location_id, to_location_id, qty, new_batch_id, created_at`,
      [companyId, raw_material_id, from_location_id, to_location_id, qty, newBatchId, req.auth!.userId]
    );
    transfer = { ...transferResult.rows[0], avg_cost_per_unit: avgCostPerUnit };

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'stock_transferred', entityType: 'stock_transfers', entityId: transfer.id, req });

  res.status(201).json({ success: true, transfer });
});

/**
 * DELETE /api/stock-transfers/:id
 * Admin/manager only. Reverses a transfer: deletes the batch it created at the
 * destination and puts the qty back at the source as a fresh batch (same cost).
 * Only allowed if none of the destination batch has been consumed yet — the
 * original source batch split isn't stored, so a byte-for-byte undo isn't possible
 * once downstream sales/waste have touched it.
 */
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const transferResult = await client.query(
      `SELECT id, raw_material_id, from_location_id, to_location_id, qty, new_batch_id
       FROM stock_transfers WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    if (!transferResult.rows[0]) throw new AppError(404, 'Transfer not found');
    const t = transferResult.rows[0];

    if (t.new_batch_id) {
      const batchResult = await client.query(
        `SELECT id, qty_purchased, qty_remaining, purchase_price, expiry_date FROM raw_material_batches WHERE id = $1 FOR UPDATE`,
        [t.new_batch_id]
      );
      const batch = batchResult.rows[0];
      if (batch) {
        if (Number(batch.qty_remaining) !== Number(batch.qty_purchased)) {
          throw new AppError(400, 'Cannot undo — some of the transferred stock has already been used at the destination');
        }
        await client.query('DELETE FROM raw_material_batches WHERE id = $1', [t.new_batch_id]);
        await client.query(
          `INSERT INTO raw_material_batches (company_id, raw_material_id, location_id, purchase_date, expiry_date, qty_purchased, qty_remaining, purchase_price)
           VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $5, $6)`,
          [companyId, t.raw_material_id, t.from_location_id, batch.expiry_date, t.qty, batch.purchase_price]
        );
      }
    }

    await client.query('DELETE FROM stock_transfers WHERE id = $1 AND company_id = $2', [id, companyId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'stock_transfer_reversed', entityType: 'stock_transfers', entityId: id as string, req });

  res.status(200).json({ success: true, message: 'Transfer reversed' });
});

/**
 * GET /api/stock-transfers
 * List transfer history, optionally filtered by raw_material_id/from_location_id/to_location_id.
 */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { raw_material_id, from_location_id, to_location_id } = req.query;

  const params: unknown[] = [companyId];
  let where = 'company_id = $1';

  if (typeof raw_material_id === 'string') {
    params.push(raw_material_id);
    where += ` AND raw_material_id = $${params.length}`;
  }
  if (typeof from_location_id === 'string') {
    params.push(from_location_id);
    where += ` AND from_location_id = $${params.length}`;
  }
  if (typeof to_location_id === 'string') {
    params.push(to_location_id);
    where += ` AND to_location_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT id, raw_material_id, from_location_id, to_location_id, qty, new_batch_id, transferred_by, created_at
     FROM stock_transfers WHERE ${where} ORDER BY created_at DESC`,
    params
  );

  res.status(200).json({ success: true, transfers: result.rows });
});
