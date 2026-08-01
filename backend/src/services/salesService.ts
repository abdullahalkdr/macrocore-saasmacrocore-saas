import { PoolClient } from 'pg';
import { AppError } from '../middleware/errorHandler';
import { consumeRawMaterial } from '../utils/inventory';
import { UNIT_TO_BASE } from '../utils/costing';

export interface CreateSaleInput {
  id?: string; // client-supplied id, used by offline sync push — omit to let the DB generate one
  companyId: string;
  shiftId: string;
  productId: string;
  productSizeId?: string | null;
  qty: number;
  unitPrice?: number;
  paymentMethod?: string;
  appCommissionPct?: number;
  createdBy: string;
}

// Shared by POST /api/sales and the offline sync push handler — same atomic
// stock-check-and-decrement, same shift-must-be-open rule, same price fallback.
export async function createSaleTx(client: PoolClient, input: CreateSaleInput) {
  const shift = await client.query(`SELECT id, status, location_id FROM shifts WHERE id = $1 AND company_id = $2 FOR UPDATE`, [input.shiftId, input.companyId]);
  if (!shift.rows[0]) throw new AppError(404, 'Shift not found');
  if (shift.rows[0].status !== 'open') throw new AppError(400, 'Shift is not open');
  const locationId: string | null = shift.rows[0].location_id;
  if (!locationId) throw new AppError(400, 'Shift has no location — cannot determine which inventory to consume from');

  // Null-safe equality spelled out with OR instead of "IS NOT DISTINCT FROM" — same result,
  // but plain "=" would never match when product_size_id is NULL (products without sizes),
  // since NULL = NULL is never true in SQL.
  const decremented = await client.query(
    `UPDATE shift_assignments SET remaining_qty = remaining_qty - $1
     WHERE shift_id = $2 AND product_id = $3
       AND (product_size_id = $4 OR (product_size_id IS NULL AND $4::uuid IS NULL))
       AND remaining_qty >= $1
     RETURNING remaining_qty`,
    [input.qty, input.shiftId, input.productId, input.productSizeId ?? null]
  );
  if (!decremented.rows[0]) {
    throw new AppError(400, 'Not enough remaining stock for this product/size on this shift (or it was never assigned to it)');
  }

  // Consume raw materials from batches (FIFO) for this sale
  const ingredientsQuery = input.productSizeId
    ? `SELECT pi.raw_material_id, pi.usage_qty, pi.usage_unit
       FROM product_size_ingredients pi
       WHERE pi.product_size_id = $1`
    : `SELECT pi.raw_material_id, pi.usage_qty, pi.usage_unit
       FROM product_ingredients pi
       WHERE pi.product_id = $1`;

  const ingredientsParams = [input.productSizeId || input.productId];
  const ingredientsResult = await client.query(ingredientsQuery, ingredientsParams);

  // Cost of goods sold for this sale — sum of (weighted-avg cost per unit × qty
  // consumed) across every ingredient. Persisted on the sale row so reports can
  // compute a real profit (revenue - COGS), not just revenue - expenses.
  let costOfGoods = 0;
  for (const ingredient of ingredientsResult.rows) {
    const factor = ingredient.usage_unit ? UNIT_TO_BASE[ingredient.usage_unit] || 1 : 1;
    const qtyToConsume = (ingredient.usage_qty || 0) * (factor ?? 1) * input.qty;

    if (qtyToConsume > 0) {
      try {
        const { avgCostPerUnit } = await consumeRawMaterial(client, input.companyId, locationId, ingredient.raw_material_id, qtyToConsume);
        costOfGoods += avgCostPerUnit * qtyToConsume;
      } catch (err) {
        throw new AppError(
          400,
          `Cannot complete sale: insufficient raw material inventory at this location. ${(err as any).message || 'Check inventory levels.'}`
        );
      }
    }
  }

  let finalUnitPrice: number = input.unitPrice ?? 0;
  if (input.unitPrice === undefined) {
    if (input.productSizeId) {
      const size = await client.query('SELECT sell_price FROM product_sizes WHERE id = $1 AND product_id = $2', [input.productSizeId, input.productId]);
      finalUnitPrice = size.rows[0]?.sell_price ?? 0;
    } else {
      const product = await client.query('SELECT sell_price FROM products WHERE id = $1 AND company_id = $2', [input.productId, input.companyId]);
      finalUnitPrice = product.rows[0]?.sell_price ?? 0;
    }
  }
  const totalPrice = input.qty * finalUnitPrice;

  const columns = ['company_id', 'shift_id', 'product_id', 'product_size_id', 'qty', 'unit_price', 'total_price', 'payment_method', 'app_commission_pct', 'created_by', 'cost_of_goods'];
  const values: unknown[] = [
    input.companyId,
    input.shiftId,
    input.productId,
    input.productSizeId ?? null,
    input.qty,
    finalUnitPrice,
    totalPrice,
    input.paymentMethod ?? 'cash',
    input.appCommissionPct ?? 0,
    input.createdBy,
    costOfGoods,
  ];
  if (input.id) {
    columns.unshift('id');
    values.unshift(input.id);
  }
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

  const saleResult = await client.query(
    `INSERT INTO sales (${columns.join(', ')}) VALUES (${placeholders})
     RETURNING id, product_id, product_size_id, qty, unit_price, total_price, payment_method, created_at`,
    values
  );

  return { sale: saleResult.rows[0], remainingQty: decremented.rows[0].remaining_qty };
}
