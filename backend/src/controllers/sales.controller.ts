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

// Void within 5 minutes of creation — restores the stock it consumed.
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sale = await client.query(
      `SELECT id, shift_id, product_id, qty, created_at FROM sales WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId]
    );
    if (!sale.rows[0]) throw new AppError(404, 'Sale not found');

    const ageMs = Date.now() - new Date(sale.rows[0].created_at).getTime();
    if (ageMs > 5 * 60 * 1000) throw new AppError(400, 'Sale can only be voided within 5 minutes of creation');

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
