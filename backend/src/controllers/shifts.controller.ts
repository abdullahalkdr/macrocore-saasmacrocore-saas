import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { isForeignKeyViolation } from '../utils/dbErrors';

interface AssignmentInput {
  product_id: string;
  product_size_id?: string;
  assigned_qty: number;
}

// Added for the frontend: it needs to resume "is there an open shift" across page
// reloads, which isn't possible with only get-by-id. Every other resource in this
// API has a list endpoint — shifts was the one gap.
export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { status } = req.query;
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));

  const params: unknown[] = [companyId];
  let where = 'company_id = $1';
  if (typeof status === 'string') {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  params.push(limit);

  const result = await pool.query(
    `SELECT id, employee_id, location_id, date, opened_at, closed_at, status
     FROM shifts WHERE ${where} ORDER BY opened_at DESC LIMIT $${params.length}`,
    params
  );
  res.status(200).json({ success: true, shifts: result.rows });
});

export const open = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { employee_id, location_id, assignments } = req.body ?? {};

  const assignmentList: AssignmentInput[] = Array.isArray(assignments) ? assignments : [];
  for (const a of assignmentList) {
    if (typeof a.product_id !== 'string' || typeof a.assigned_qty !== 'number' || a.assigned_qty < 0) {
      throw new AppError(400, 'each assignment needs product_id (string) and assigned_qty (non-negative number)');
    }
    if (a.product_size_id !== undefined && typeof a.product_size_id !== 'string') {
      throw new AppError(400, 'product_size_id must be a string when provided');
    }
  }

  // has_sizes products need one assignment row per size, each tagged with which size —
  // otherwise stock and sales can't tell a Small from a Large on this shift.
  const productIds = [...new Set(assignmentList.map((a) => a.product_id))];
  if (productIds.length > 0) {
    const placeholders = productIds.map((_, i) => `$${i + 1}`).join(', ');
    const sizedProducts = await pool.query(
      `SELECT id FROM products WHERE id IN (${placeholders}) AND company_id = $${productIds.length + 1} AND has_sizes = true`,
      [...productIds, companyId]
    );
    const sizedProductIds = new Set(sizedProducts.rows.map((r) => r.id));
    for (const a of assignmentList) {
      if (sizedProductIds.has(a.product_id) && !a.product_size_id) {
        throw new AppError(400, `product ${a.product_id} has sizes — each assignment needs a product_size_id`);
      }
    }
  }

  const client = await pool.connect();
  let shift;
  try {
    await client.query('BEGIN');

    const shiftResult = await client.query(
      `INSERT INTO shifts (company_id, employee_id, location_id, date, opened_at, status)
       VALUES ($1, $2, $3, CURRENT_DATE, NOW(), 'open')
       RETURNING id, status, opened_at, date`,
      [companyId, employee_id ?? null, location_id ?? null]
    );
    shift = shiftResult.rows[0];

    for (const a of assignmentList) {
      await client.query(
        `INSERT INTO shift_assignments (shift_id, product_id, product_size_id, assigned_qty, remaining_qty)
         VALUES ($1, $2, $3, $4, $4)`,
        [shift.id, a.product_id, a.product_size_id ?? null, a.assigned_qty]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (isForeignKeyViolation(err)) throw new AppError(400, 'assignments reference a product_id that does not exist');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'shift_opened', entityType: 'shifts', entityId: shift.id, req });

  res.status(201).json({ success: true, shift });
});

export const close = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const existing = await pool.query('SELECT id, status FROM shifts WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Shift not found');
  if (existing.rows[0].status === 'closed') throw new AppError(400, 'Shift is already closed');

  const totals = await pool.query(
    `SELECT COUNT(*)::int AS total_sales, COALESCE(SUM(total_price), 0)::float AS total_revenue
     FROM sales WHERE shift_id = $1`,
    [id]
  );

  const result = await pool.query(
    `UPDATE shifts SET status = 'closed', closed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND company_id = $2
     RETURNING id, status, opened_at, closed_at`,
    [id, companyId]
  );
  const shift = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'shift_closed', entityType: 'shifts', entityId: shift.id, req });

  res.status(200).json({
    success: true,
    shift: { ...shift, total_sales: totals.rows[0].total_sales, total_revenue: totals.rows[0].total_revenue },
  });
});

// Admin/manager only — corrects a shift's employee/location/date/status directly
// (e.g. wrong location picked at open time). Doesn't touch sales/assignments.
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { employee_id, location_id, date, status } = req.body ?? {};

  if (status !== undefined && !['open', 'closed'].includes(status)) {
    throw new AppError(400, 'status must be open or closed');
  }

  const existing = await pool.query(
    `SELECT id, employee_id, location_id, date, status FROM shifts WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!existing.rows[0]) throw new AppError(404, 'Shift not found');
  const current = existing.rows[0];

  const result = await pool.query(
    `UPDATE shifts SET employee_id = $1, location_id = $2, date = $3, status = $4, updated_at = NOW()
     WHERE id = $5 AND company_id = $6
     RETURNING id, employee_id, location_id, date, opened_at, closed_at, status`,
    [
      employee_id !== undefined ? employee_id : current.employee_id,
      location_id !== undefined ? location_id : current.location_id,
      date !== undefined ? date : current.date,
      status !== undefined ? status : current.status,
      id,
      companyId,
    ]
  );
  const shift = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'shift_updated', entityType: 'shifts', entityId: shift.id, req });

  res.status(200).json({ success: true, shift });
});

// Admin/manager only — hard delete: removes the shift and everything recorded
// directly under it (sales, waste, cash counts, product assignments). Does NOT
// restore raw-material FIFO batch quantities those sales/waste consumed — for a
// full pre-launch data wipe use docs/RESET_TEST_DATA.sql instead of looping this.
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM shifts WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, companyId]);
    if (!existing.rows[0]) throw new AppError(404, 'Shift not found');

    await client.query('DELETE FROM sales WHERE shift_id = $1 AND company_id = $2', [id, companyId]);
    await client.query('DELETE FROM waste_records WHERE shift_id = $1 AND company_id = $2', [id, companyId]);
    await client.query('DELETE FROM cash_denominations WHERE shift_id = $1 AND company_id = $2', [id, companyId]);
    await client.query('DELETE FROM shift_assignments WHERE shift_id = $1', [id]);
    await client.query('DELETE FROM shifts WHERE id = $1 AND company_id = $2', [id, companyId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'shift_deleted', entityType: 'shifts', entityId: id as string, req });

  res.status(200).json({ success: true, message: 'Shift deleted' });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const shiftResult = await pool.query(
    `SELECT id, employee_id, location_id, date, opened_at, closed_at, status FROM shifts WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  const shift = shiftResult.rows[0];
  if (!shift) throw new AppError(404, 'Shift not found');

  const assignments = await pool.query(
    `SELECT id, product_id, product_size_id, assigned_qty, remaining_qty FROM shift_assignments WHERE shift_id = $1`,
    [id]
  );
  const salesSummary = await pool.query(
    `SELECT COUNT(*)::int AS total_sales, COALESCE(SUM(total_price), 0)::float AS total_revenue FROM sales WHERE shift_id = $1`,
    [id]
  );

  res.status(200).json({ success: true, shift, assignments: assignments.rows, ...salesSummary.rows[0] });
});
