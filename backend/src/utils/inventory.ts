/**
 * FIFO Inventory management utilities.
 * Handles batch-level consumption using First-In-First-Out ordering.
 */

import { PoolClient } from 'pg';
import { AppError } from '../middleware/errorHandler';

export interface RawMaterialBatch {
  id: string;
  company_id: string;
  raw_material_id: string;
  location_id: string;
  purchase_date: string; // DATE
  expiry_date: string | null; // DATE or NULL
  qty_purchased: number;
  qty_remaining: number;
  purchase_price: number;
  created_at: string;
  updated_at: string;
}

export interface ConsumedBatchDetail {
  batchId: string;
  qtyConsumed: number;
  purchasePrice: number;
  expiryDate: string | null;
}

export interface ConsumeResult {
  consumed: number;
  avgCostPerUnit: number;
  // Most conservative (earliest) expiry_date among the batches actually consumed —
  // NULL only if every consumed batch had no expiry_date at all. Used by stock
  // transfers to carry a shelf-life over to the new batch at the destination.
  earliestExpiryDate: string | null;
  batches: ConsumedBatchDetail[];
}

/**
 * Consume qty units of a raw material following FIFO order, scoped to ONE location.
 * Deducts from the oldest batch first, then moves to the next batch. A kiosk can only
 * consume from its own batches — never a warehouse's or another kiosk's (see
 * docs/MIGRATION_006_location_inventory.sql). Use transferStock() to move stock between
 * locations first.
 *
 * @param client - PoolClient for transactional execution
 * @param companyId - Company ID
 * @param locationId - Location ID (kiosk or warehouse) to consume from
 * @param rawMaterialId - Raw material ID
 * @param qty - Quantity to consume (in base units, e.g., grams, ml, pieces)
 * @returns consumed qty, weighted-average cost, earliest expiry among consumed batches,
 *          and the per-batch breakdown — or throws AppError if insufficient stock at this location.
 *
 * Logic:
 *  1. Fetch this location's batches for this material, ordered by: expired-first, expiry_date ASC, purchase_date ASC
 *  2. Iterate through batches, deducting qty from qty_remaining
 *  3. Calculate weighted average of purchase prices from all batches touched
 */
export async function consumeRawMaterial(
  client: PoolClient,
  companyId: string,
  locationId: string,
  rawMaterialId: string,
  qty: number
): Promise<ConsumeResult> {
  if (qty <= 0) {
    return { consumed: 0, avgCostPerUnit: 0, earliestExpiryDate: null, batches: [] };
  }

  // Fetch this location's batches for this material, ordered by expiry (expired first), then purchase date (oldest first).
  const batchesResult = await client.query(
    `SELECT id, qty_remaining, purchase_price, expiry_date
     FROM raw_material_batches
     WHERE company_id = $1 AND location_id = $2 AND raw_material_id = $3 AND qty_remaining > 0
     ORDER BY
       CASE WHEN expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE THEN 0 ELSE 1 END,
       expiry_date ASC NULLS LAST,
       purchase_date ASC
     FOR UPDATE`,
    [companyId, locationId, rawMaterialId]
  );

  const batches = batchesResult.rows;
  if (batches.length === 0) {
    throw new AppError(400, `No available inventory for this raw material at this location. Stock may not have been transferred here yet.`);
  }

  let remainingQty = qty;
  const consumedBatches: ConsumedBatchDetail[] = [];

  for (const batch of batches) {
    if (remainingQty <= 0) break;

    const qtyConsumed = Math.min(remainingQty, batch.qty_remaining);
    remainingQty -= qtyConsumed;

    consumedBatches.push({
      batchId: batch.id,
      qtyConsumed,
      purchasePrice: batch.purchase_price,
      expiryDate: batch.expiry_date,
    });
  }

  if (remainingQty > 0) {
    throw new AppError(
      400,
      `Insufficient inventory at this location for this raw material. Requested: ${qty}, Available: ${qty - remainingQty}. Stock may not have been transferred here yet.`
    );
  }

  // Deduct from batches (in the same order as above)
  for (const cb of consumedBatches) {
    await client.query(
      `UPDATE raw_material_batches SET qty_remaining = qty_remaining - $1, updated_at = NOW()
       WHERE id = $2`,
      [cb.qtyConsumed, cb.batchId]
    );
  }

  // Calculate weighted average cost per unit
  let totalCost = 0;
  let totalQty = 0;
  let earliestExpiryDate: string | null = null;
  for (const cb of consumedBatches) {
    totalCost += cb.qtyConsumed * cb.purchasePrice;
    totalQty += cb.qtyConsumed;
    if (cb.expiryDate !== null) {
      if (earliestExpiryDate === null || cb.expiryDate < earliestExpiryDate) {
        earliestExpiryDate = cb.expiryDate;
      }
    }
  }
  const avgCostPerUnit = totalQty > 0 ? totalCost / totalQty : 0;

  return { consumed: qty, avgCostPerUnit, earliestExpiryDate, batches: consumedBatches };
}

/**
 * Transfer stock from one location to another (e.g. warehouse -> kiosk).
 * Consumes FIFO from the source location's batches (possibly spanning several),
 * then creates ONE new batch at the destination with:
 *   - purchase_price = weighted-average cost of what was consumed
 *   - purchase_date  = today (this is when stock entered the destination location)
 *   - expiry_date    = earliest expiry among the consumed source batches (most
 *                      conservative — a transfer never resets a shelf-life clock)
 *
 * @returns the newly created batch id and the transfer's effective unit cost
 */
export async function transferStock(
  client: PoolClient,
  companyId: string,
  rawMaterialId: string,
  fromLocationId: string,
  toLocationId: string,
  qty: number
): Promise<{ newBatchId: string; avgCostPerUnit: number }> {
  if (fromLocationId === toLocationId) {
    throw new AppError(400, 'Source and destination locations must be different');
  }
  if (qty <= 0) {
    throw new AppError(400, 'Transfer quantity must be positive');
  }

  const { avgCostPerUnit, earliestExpiryDate } = await consumeRawMaterial(client, companyId, fromLocationId, rawMaterialId, qty);

  const newBatchResult = await client.query(
    `INSERT INTO raw_material_batches (company_id, raw_material_id, location_id, purchase_date, expiry_date, qty_purchased, qty_remaining, purchase_price)
     VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $5, $6)
     RETURNING id`,
    [companyId, rawMaterialId, toLocationId, earliestExpiryDate, qty, avgCostPerUnit]
  );

  return { newBatchId: newBatchResult.rows[0].id, avgCostPerUnit };
}

/**
 * Get the current effective purchase price of a raw material (for costing).
 * Returns the purchase price of the oldest batch with qty_remaining > 0.
 * If no batches exist, falls back to raw_materials.purchase_price.
 *
 * @param client - PoolClient
 * @param companyId - Company ID
 * @param rawMaterialId - Raw material ID
 * @returns Purchase price (number)
 */
export async function getCurrentPurchasePrice(
  client: PoolClient,
  companyId: string,
  rawMaterialId: string
): Promise<number> {
  // Try to get the oldest batch with qty_remaining > 0
  const batchResult = await client.query(
    `SELECT purchase_price
     FROM raw_material_batches
     WHERE company_id = $1 AND raw_material_id = $2 AND qty_remaining > 0
     ORDER BY
       CASE WHEN expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE THEN 0 ELSE 1 END,
       expiry_date ASC NULLS LAST,
       purchase_date ASC
     LIMIT 1`,
    [companyId, rawMaterialId]
  );

  if (batchResult.rows[0]) {
    return batchResult.rows[0].purchase_price;
  }

  // Fallback: use the raw_materials.purchase_price
  const materialResult = await client.query(
    `SELECT purchase_price FROM raw_materials WHERE id = $1 AND company_id = $2`,
    [rawMaterialId, companyId]
  );
  return materialResult.rows[0]?.purchase_price ?? 0;
}

/**
 * Check if any batches for a material are expiring soon (within days).
 * Returns list of batches within the threshold.
 *
 * @param client - PoolClient
 * @param companyId - Company ID
 * @param daysThreshold - Number of days to look ahead (e.g., 30 for 30-day alerts)
 * @returns Array of batches expiring soon
 */
export async function getExpiringBatches(
  client: PoolClient,
  companyId: string,
  daysThreshold: number = 30
): Promise<RawMaterialBatch[]> {
  const result = await client.query(
    `SELECT id, company_id, raw_material_id, location_id, purchase_date, expiry_date, qty_purchased, qty_remaining, purchase_price, created_at, updated_at
     FROM raw_material_batches
     WHERE company_id = $1
       AND qty_remaining > 0
       AND expiry_date IS NOT NULL
       AND expiry_date <= CURRENT_DATE + INTERVAL '1 day' * $2
       AND expiry_date > CURRENT_DATE
     ORDER BY expiry_date ASC`,
    [companyId, daysThreshold]
  );
  return result.rows;
}

/**
 * Get all batches for a specific raw material (across all locations, unless locationId is given).
 *
 * @param client - PoolClient
 * @param companyId - Company ID
 * @param rawMaterialId - Raw material ID
 * @param locationId - Optional: restrict to one location
 * @returns Array of batches
 */
export async function getBatchesForMaterial(
  client: PoolClient,
  companyId: string,
  rawMaterialId: string,
  locationId?: string
): Promise<RawMaterialBatch[]> {
  const params: unknown[] = [companyId, rawMaterialId];
  let where = 'company_id = $1 AND raw_material_id = $2';
  if (locationId) {
    params.push(locationId);
    where += ` AND location_id = $${params.length}`;
  }
  const result = await client.query(
    `SELECT id, company_id, raw_material_id, location_id, purchase_date, expiry_date, qty_purchased, qty_remaining, purchase_price, created_at, updated_at
     FROM raw_material_batches
     WHERE ${where}
     ORDER BY
       CASE WHEN expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE THEN 0 ELSE 1 END,
       expiry_date ASC NULLS LAST,
       purchase_date ASC`,
    params
  );
  return result.rows;
}
