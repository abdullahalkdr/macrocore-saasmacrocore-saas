import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { createSaleTx } from '../services/salesService';
import { resolveCommissionPct } from '../utils/commission';

// cash/knet settle straight to the till; jahez/vthru are delivery apps that take a cut
// before the kiosk sees the money — see docs/MIGRATION_002_priority1.sql.
const PAYMENT_METHODS = ['cash', 'knet', 'jahez', 'vthru'];

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { shift_id, product_id, product_size_id, qty, unit_price, payment_method, app_commission_pct } = req.body ?? {};

  if (typeof shift_id !== 'string') throw new AppError(400, 'shift_id is required');
  if (typeof product_id !== 'string') throw new AppError(400, 'product_id is required');
  if (typeof qty !== 'number' || qty <= 0) throw new AppError(400, 'qty must be a positive number');
  if (product_size_id !== undefined && typeof product_size_id !== 'string') {
    throw new AppError(400, 'product_size_id must be a string when provided');
  }
  if (payment_method !== undefined && !PAYMENT_METHODS.includes(payment_method)) {
    throw new AppError(400, `payment_method must be one of ${PAYMENT_METHODS.join(', ')}`);
  }

  const commissionPct = await resolveCommissionPct(companyId, payment_method, req.auth!.role, app_commission_pct);

  const client = await pool.connect();
  let sale, remainingQty;
  try {
    await client.query('BEGIN');
    const result = await createSaleTx(client, {
      companyId,
      shiftId: shift_id,
      productId: product_id,
      productSizeId: product_size_id ?? null,
      qty,
      unitPrice: unit_price,
      paymentMethod: payment_method,
      appCommissionPct: commissionPct,
      createdBy: req.auth!.userId,
    });
    sale = result.sale;
    remainingQty = result.remainingQty;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'sale_created', entityType: 'sales', entityId: sale.id, req });

  res.status(201).json({ success: true, sale, remaining_qty: remainingQty, message: 'Sale recorded.' });
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { shift_id, date } = req.query;
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));

  const params: unknown[] = [companyId];
  let where = 'company_id = $1';
  if (typeof shift_id === 'string') {
    params.push(shift_id);
    where += ` AND shift_id = $${params.length}`;
  }
  if (typeof date === 'string') {
    params.push(date);
    where += ` AND created_at::date = $${params.length}`;
  }
  params.push(limit);

  const result = await pool.query(
    `SELECT id, shift_id, product_id, product_size_id, qty, unit_price, total_price, payment_method, created_at
     FROM sales WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  const totalResult = await pool.query(`SELECT COUNT(*)::int AS n FROM sales WHERE ${where}`, params.slice(0, -1));

  res.status(200).json({ success: true, sales: result.rows, total: totalResult.rows[0].n });
});

// Update: admin/manager only — corrects qty/price/payment method on an already-recorded
// sale (e.g. a cashier typo) without needing to void+recreate. Adjusts the shift
// assignment's remaining_qty by the qty delta, same scope as void() below.
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { qty, unit_price, payment_method, app_commission_pct } = req.body ?? {};

  if (qty !== undefined && (typeof qty !== 'number' || qty <= 0)) throw new AppError(400, 'qty must be a positive number');
  if (unit_price !== undefined && (typeof unit_price !== 'number' || unit_price < 0)) {
    throw new AppError(400, 'unit_price must be a non-negative number');
  }
  if (payment_method !== undefined && !PAYMENT_METHODS.includes(payment_method)) {
    throw new AppError(400, `payment_method must be one of ${PAYMENT_METHODS.join(', ')}`);
  }

  const client = await pool.connect();
  let sale;
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, shift_id, product_id, qty, unit_price, app_commission_pct FROM sales WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    if (!existing.rows[0]) throw new AppError(404, 'Sale not found');
    const current = existing.rows[0];

    const newQty = qty ?? Number(current.qty);
    const newUnitPrice = unit_price ?? Number(current.unit_price);
    const newCommission = app_commission_pct ?? Number(current.app_commission_pct);
    const newTotal = newQty * newUnitPrice;

    const qtyDelta = Number(current.qty) - newQty; // positive = give stock back, negative = take more
    if (qtyDelta !== 0) {
      await client.query(
        `UPDATE shift_assignments SET remaining_qty = remaining_qty + $1 WHERE shift_id = $2 AND product_id = $3`,
        [qtyDelta, current.shift_id, current.product_id]
      );
    }

    const result = await client.query(
      `UPDATE sales SET qty = $1, unit_price = $2, total_price = $3,
              payment_method = COALESCE($4, payment_method), app_commission_pct = $5, version = version + 1
       WHERE id = $6 AND company_id = $7
       RETURNING id, shift_id, product_id, product_size_id, qty, unit_price, total_price, payment_method, app_commission_pct, created_at`,
      [newQty, newUnitPrice, newTotal, payment_method ?? null, newCommission, id, companyId]
    );
    sale = result.rows[0];

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'sale_updated', entityType: 'sales', entityId: sale.id, req });

  res.status(200).json({ success: true, sale });
});

// Void within 5 minutes of creation for regular staff — admin/manager can void anytime.
// Restores the stock it consumed.
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const isPrivileged = req.auth!.role === 'admin' || req.auth!.role === 'manager';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sale = await client.query(
      `SELECT id, shift_id, product_id, qty, created_at FROM sales WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    if (!sale.rows[0]) throw new AppError(404, 'Sale not found');

    if (!isPrivileged) {
      const ageMs = Date.now() - new Date(sale.rows[0].created_at).getTime();
      if (ageMs > 5 * 60 * 1000) throw new AppError(400, 'Sale can only be voided within 5 minutes of creation');
    }

    await client.query(
      `UPDATE shift_assignments SET remaining_qty = remaining_qty + $1 WHERE shift_id = $2 AND product_id = $3`,
      [sale.rows[0].qty, sale.rows[0].shift_id, sale.rows[0].product_id]
    );
    await client.query('DELETE FROM sales WHERE id = $1', [id]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'sale_voided', entityType: 'sales', entityId: id as string, req });

  res.status(200).json({ success: true, message: 'Sale deleted' });
});
