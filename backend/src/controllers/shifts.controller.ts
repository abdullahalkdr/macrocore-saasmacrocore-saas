import { Request, Response } from 'express';
import { PoolClient } from 'pg';
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

// Fixed KWD denomination set — matches the physical notes/coins a cashier counts at
// close time. Whitelisted here so cash_denominations never accumulates garbage values.
export const CASH_DENOMINATIONS = [20, 10, 5, 1, 0.5, 0.25, 0.1, 0.05];

interface CashCountInput {
  denomination: number;
  count: number;
}
interface ProductCountInput {
  shift_assignment_id: string;
  actual_remaining_qty: number;
}

// Shared by close() and updateReconciliation() — validates and atomically saves the
// physical product count + cash denomination count + note for a shift. Requires EVERY
// assignment to have a count and EVERY denomination to be present (default 0), so a
// partial/skipped count can never look like a real reconciliation.
async function saveReconciliation(
  client: PoolClient,
  companyId: string,
  shiftId: string,
  cashCounts: unknown,
  productCounts: unknown
): Promise<void> {
  if (!Array.isArray(cashCounts)) throw new AppError(400, 'cash_counts is required (array of { denomination, count })');
  const seenDenominations = new Set<number>();
  for (const cc of cashCounts as CashCountInput[]) {
    if (typeof cc?.denomination !== 'number' || !CASH_DENOMINATIONS.includes(cc.denomination)) {
      throw new AppError(400, `denomination must be one of ${CASH_DENOMINATIONS.join(', ')}`);
    }
    if (typeof cc.count !== 'number' || cc.count < 0 || !Number.isInteger(cc.count)) {
      throw new AppError(400, 'count must be a non-negative integer');
    }
    seenDenominations.add(cc.denomination);
  }
  if (seenDenominations.size !== CASH_DENOMINATIONS.length) {
    throw new AppError(400, 'cash_counts must include every denomination (use 0 for ones not counted)');
  }

  const assignmentsResult = await client.query('SELECT id FROM shift_assignments WHERE shift_id = $1', [shiftId]);
  const assignmentIds = new Set(assignmentsResult.rows.map((r) => r.id));

  if (!Array.isArray(productCounts)) throw new AppError(400, 'product_counts is required (array of { shift_assignment_id, actual_remaining_qty })');
  const seenAssignments = new Set<string>();
  for (const pc of productCounts as ProductCountInput[]) {
    if (typeof pc?.shift_assignment_id !== 'string' || !assignmentIds.has(pc.shift_assignment_id)) {
      throw new AppError(400, 'product_counts references a shift_assignment_id that does not belong to this shift');
    }
    if (typeof pc.actual_remaining_qty !== 'number' || pc.actual_remaining_qty < 0) {
      throw new AppError(400, 'actual_remaining_qty must be a non-negative number');
    }
    seenAssignments.add(pc.shift_assignment_id);
  }
  if (seenAssignments.size !== assignmentIds.size) {
    throw new AppError(400, 'product_counts must include every product assigned to this shift');
  }

  for (const pc of productCounts as ProductCountInput[]) {
    await client.query('UPDATE shift_assignments SET actual_remaining_qty = $1 WHERE id = $2', [pc.actual_remaining_qty, pc.shift_assignment_id]);
  }

  await client.query('DELETE FROM cash_denominations WHERE shift_id = $1', [shiftId]);
  for (const cc of cashCounts as CashCountInput[]) {
    if (cc.count === 0) continue;
    const total = cc.denomination * cc.count;
    await client.query(
      `INSERT INTO cash_denominations (company_id, shift_id, denomination, count, total) VALUES ($1, $2, $3, $4, $5)`,
      [companyId, shiftId, cc.denomination, cc.count, total]
    );
  }
}

// Added for the frontend: it needs to resume "is there an open shift" across page
// reloads, which isn't possible with only get-by-id. Every other resource in this
// API has a list endpoint — shifts was the one gap. Now also the source for the
// shift hub's open-shifts list and closed-shifts log, so it's grown employee/location
// names and a computed cash-match flag for closed shifts.
export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { status } = req.query;
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));

  const params: unknown[] = [companyId];
  let where = 's.company_id = $1';
  if (typeof status === 'string') {
    params.push(status);
    where += ` AND s.status = $${params.length}`;
  }
  params.push(limit);

  const result = await pool.query(
    `SELECT s.id, s.employee_id, e.name AS employee_name, s.location_id, l.name AS location_name,
            s.date, s.opened_at, s.closed_at, s.status, s.closing_notes,
            COALESCE(sale_totals.total_cash_sales, 0)::float AS total_cash_sales,
            COALESCE(cash_totals.counted_cash, 0)::float AS counted_cash
     FROM shifts s
     LEFT JOIN employees e ON e.id = s.employee_id
     LEFT JOIN locations l ON l.id = s.location_id
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(total_price) FILTER (WHERE payment_method = 'cash'), 0) AS total_cash_sales
       FROM sales WHERE sales.shift_id = s.id
     ) sale_totals ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(total), 0) AS counted_cash FROM cash_denominations WHERE cash_denominations.shift_id = s.id
     ) cash_totals ON true
     WHERE ${where} ORDER BY s.opened_at DESC LIMIT $${params.length}`,
    params
  );

  const shifts = result.rows.map((r) => ({
    ...r,
    is_match: r.status === 'closed' ? Math.abs(Number(r.counted_cash) - Number(r.total_cash_sales)) < 0.001 : null,
  }));

  res.status(200).json({ success: true, shifts });
});

export const open = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { employee_id, location_id, assignments } = req.body ?? {};

  // Required: inventory is tracked per-location (raw_material_batches), and sales/waste
  // can't determine which batches to consume from without it — a shift opened without a
  // location used to silently break the first sale instead of failing here up front.
  if (typeof location_id !== 'string' || !location_id) {
    throw new AppError(400, 'location_id is required to open a shift');
  }
  const location = await pool.query('SELECT id FROM locations WHERE id = $1 AND company_id = $2', [location_id, companyId]);
  if (!location.rows[0]) throw new AppError(400, 'location_id not found');

  if (employee_id !== undefined && employee_id !== null) {
    if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id must be a string');
    const employee = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [employee_id, companyId]);
    if (!employee.rows[0]) throw new AppError(400, 'employee_id not found');
  }

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

// Close requires a full reconciliation: a physical count of every product still on
// hand, and a cash-drawer count by denomination. Both save atomically with the status
// flip so a shift can never end up "closed" with a half-entered count.
export const close = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { cash_counts, product_counts, closing_notes } = req.body ?? {};

  const existing = await pool.query('SELECT id, status FROM shifts WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Shift not found');
  if (existing.rows[0].status === 'closed') throw new AppError(400, 'Shift is already closed');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await saveReconciliation(client, companyId, id as string, cash_counts, product_counts);

    await client.query(
      `UPDATE shifts SET status = 'closed', closed_at = NOW(), closing_notes = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
      [typeof closing_notes === 'string' ? closing_notes : null, id, companyId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'shift_closed', entityType: 'shifts', entityId: id as string, req });

  res.status(200).json(await buildShiftDetail(companyId, id as string));
});

// Admin/manager only — re-open the reconciliation on an ALREADY closed shift to
// correct a miscount, without touching its open/closed status. Same validation and
// same atomic save as close().
export const updateReconciliation = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { cash_counts, product_counts, closing_notes } = req.body ?? {};

  const existing = await pool.query('SELECT id, status FROM shifts WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Shift not found');
  if (existing.rows[0].status !== 'closed') throw new AppError(400, 'Only a closed shift has a reconciliation to edit');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await saveReconciliation(client, companyId, id as string, cash_counts, product_counts);
    if (closing_notes !== undefined) {
      await client.query('UPDATE shifts SET closing_notes = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3', [
        typeof closing_notes === 'string' ? closing_notes : null,
        id,
        companyId,
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'shift_reconciliation_updated', entityType: 'shifts', entityId: id as string, req });

  res.status(200).json(await buildShiftDetail(companyId, id as string));
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

async function buildShiftDetail(companyId: string, id: string) {
  const shiftResult = await pool.query(
    `SELECT s.id, s.employee_id, e.name AS employee_name, s.location_id, l.name AS location_name,
            s.date, s.opened_at, s.closed_at, s.status, s.closing_notes
     FROM shifts s
     LEFT JOIN employees e ON e.id = s.employee_id
     LEFT JOIN locations l ON l.id = s.location_id
     WHERE s.id = $1 AND s.company_id = $2`,
    [id, companyId]
  );
  const shift = shiftResult.rows[0];
  if (!shift) throw new AppError(404, 'Shift not found');

  const assignments = await pool.query(
    `SELECT id, product_id, product_size_id, assigned_qty, remaining_qty, actual_remaining_qty FROM shift_assignments WHERE shift_id = $1`,
    [id]
  );
  const salesSummary = await pool.query(
    `SELECT COUNT(*)::int AS total_sales, COALESCE(SUM(total_price), 0)::float AS total_revenue,
            COALESCE(SUM(total_price) FILTER (WHERE payment_method = 'cash'), 0)::float AS total_cash_sales
     FROM sales WHERE shift_id = $1`,
    [id]
  );
  const cashDenominations = await pool.query(
    `SELECT denomination, count, total FROM cash_denominations WHERE shift_id = $1 ORDER BY denomination DESC`,
    [id]
  );
  const countedCash = cashDenominations.rows.reduce((sum, r) => sum + Number(r.total), 0);
  const totalCashSales = salesSummary.rows[0].total_cash_sales;

  return {
    success: true,
    shift,
    assignments: assignments.rows,
    ...salesSummary.rows[0],
    cash_denominations: cashDenominations.rows,
    counted_cash: countedCash,
    is_match: shift.status === 'closed' ? Math.abs(countedCash - Number(totalCashSales)) < 0.001 : null,
  };
}

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  res.status(200).json(await buildShiftDetail(companyId, id as string));
});
