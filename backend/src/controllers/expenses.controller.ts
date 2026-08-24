import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { assertDateNotClosed } from '../utils/periodGuard';
import { isCompanyGoldPlus, fileApprovalRequest } from '../utils/financialApprovals';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { date } = req.query;

  const params: unknown[] = [companyId];
  let where = 'e.company_id = $1';
  if (typeof date === 'string') {
    params.push(date);
    // Filter on the backdatable expense_date when set, otherwise fall back to
    // when the row was actually entered (older rows never got an expense_date).
    where += ` AND COALESCE(e.expense_date, e.created_at::date) = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT e.id, e.category, e.amount, e.description, e.receipt_image, e.location_id, e.expense_date,
            e.created_at, e.created_by, e.status, l.name AS location_name, u.full_name AS created_by_name
     FROM expenses e
     LEFT JOIN locations l ON l.id = e.location_id AND l.company_id = e.company_id
     LEFT JOIN users u ON u.id = e.created_by
     WHERE ${where}
     ORDER BY COALESCE(e.expense_date, e.created_at::date) DESC, e.created_at DESC`,
    params
  );
  res.status(200).json({ success: true, expenses: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { category, amount, description, receipt_image, location_id, expense_date } = req.body ?? {};

  if (typeof amount !== 'number' || amount <= 0) throw new AppError(400, 'amount must be a positive number');

  if (location_id !== undefined && location_id !== null) {
    const loc = await pool.query('SELECT id FROM locations WHERE id = $1 AND company_id = $2', [location_id, companyId]);
    if (loc.rows.length === 0) throw new AppError(400, 'location_id not found');
  }

  // No expense_date supplied -> this row is effectively dated today (list()'s
  // own COALESCE(expense_date, created_at::date) treats it the same way), so
  // that's what gets checked against closed_periods.
  const effectiveDate = typeof expense_date === 'string' && expense_date ? expense_date : new Date().toISOString().slice(0, 10);
  await assertDateNotClosed(companyId, effectiveDate);

  // MIGRATION_058 — Maker-Checker gate, Gold+ only (see financialApprovals.ts's
  // header for why: /api/expenses has no plan gate at all, unlike /api/approvals
  // which is Gold-gated — a below-Gold company must never land in
  // 'pending_approval' with no route to ever resolve it). Expenses have no separate
  // "pay/reimburse" step to gate later — the record itself IS the financial event —
  // so this is decided at creation time, not on a follow-up action like Payroll/PO.
  const goldPlus = await isCompanyGoldPlus(companyId);
  const initialStatus = goldPlus ? 'pending_approval' : 'approved';

  const result = await pool.query(
    `INSERT INTO expenses (company_id, category, amount, description, receipt_image, location_id, expense_date, created_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, category, amount, description, location_id, expense_date, created_at, status`,
    [
      companyId,
      category ?? null,
      amount,
      description ?? null,
      receipt_image ?? null,
      location_id ?? null,
      expense_date ?? null,
      req.auth!.userId,
      initialStatus,
    ]
  );
  const expense = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'expense_created', entityType: 'expenses', entityId: expense.id, req });

  if (goldPlus) {
    await fileApprovalRequest(companyId, 'EXPENSE', expense.id, req.auth!.userId);
  }

  res.status(201).json({ success: true, expense });
});

// Admin/manager only (see routes) — lets a manager fix a miskeyed amount/category/date
// after the fact instead of deleting and re-entering.
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { category, amount, description, receipt_image, location_id, expense_date } = req.body ?? {};

  // ::text cast so this comes back as a plain 'YYYY-MM-DD' string -- see
  // periodGuard.ts's note on why that's safer than a driver-parsed Date.
  const currentRow = await pool.query(
    `SELECT (COALESCE(expense_date, created_at::date))::text AS effective_date, status FROM expenses WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!currentRow.rows[0]) throw new AppError(404, 'Expense not found');
  // MIGRATION_058 — an expense awaiting approval is locked against tampering: the
  // amount/category/etc an approver is about to sign off on must not change out
  // from under them mid-review. Unblocks once the approval resolves either way
  // (approved stays editable same as always; rejected can still be corrected and
  // is NOT auto-resubmitted here — the submitter re-creates it if needed).
  if (currentRow.rows[0].status === 'pending_approval') {
    throw new AppError(400, 'This expense is awaiting approval and cannot be edited until a decision is made.');
  }
  // Block editing a record that currently sits in a closed period at all, not
  // just landing a change inside one -- otherwise a closed August row could
  // still be "fixed" (amount, category...) freely by anyone who leaves the
  // date untouched.
  await assertDateNotClosed(companyId, currentRow.rows[0].effective_date);
  // And separately block moving an open-period expense INTO a closed one via
  // a new expense_date.
  if (expense_date !== undefined && expense_date) {
    await assertDateNotClosed(companyId, expense_date);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (category !== undefined) {
    sets.push(`category = $${i++}`);
    values.push(category);
  }
  if (amount !== undefined) {
    if (typeof amount !== 'number' || amount <= 0) throw new AppError(400, 'amount must be a positive number');
    sets.push(`amount = $${i++}`);
    values.push(amount);
  }
  if (description !== undefined) {
    sets.push(`description = $${i++}`);
    values.push(description);
  }
  if (receipt_image !== undefined) {
    sets.push(`receipt_image = $${i++}`);
    values.push(receipt_image);
  }
  if (location_id !== undefined) {
    if (location_id !== null) {
      const loc = await pool.query('SELECT id FROM locations WHERE id = $1 AND company_id = $2', [location_id, companyId]);
      if (loc.rows.length === 0) throw new AppError(400, 'location_id not found');
    }
    sets.push(`location_id = $${i++}`);
    values.push(location_id);
  }
  if (expense_date !== undefined) {
    sets.push(`expense_date = $${i++}`);
    values.push(expense_date);
  }

  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE expenses SET ${sets.join(', ')}
     WHERE id = $${i++} AND company_id = $${i++}
     RETURNING id, category, amount, description, location_id, expense_date, created_at, status`,
    values
  );
  const expense = result.rows[0];
  if (!expense) throw new AppError(404, 'Expense not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'expense_updated', entityType: 'expenses', entityId: id as string, req });

  res.status(200).json({ success: true, expense });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  // Deleting is still a write against the period's financial data -- a closed
  // month shouldn't be editable by just deleting the inconvenient row instead
  // of updating it.
  const currentRow = await pool.query(
    `SELECT (COALESCE(expense_date, created_at::date))::text AS effective_date, status FROM expenses WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!currentRow.rows[0]) throw new AppError(404, 'Expense not found');
  // MIGRATION_058 — same tampering guard as update() above: don't let the record an
  // approver is reviewing disappear out from under them mid-review.
  if (currentRow.rows[0].status === 'pending_approval') {
    throw new AppError(400, 'This expense is awaiting approval and cannot be deleted until a decision is made.');
  }
  await assertDateNotClosed(companyId, currentRow.rows[0].effective_date);

  const result = await pool.query('DELETE FROM expenses WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (result.rows.length === 0) throw new AppError(404, 'Expense not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'expense_deleted', entityType: 'expenses', entityId: id as string, req });

  res.status(200).json({ success: true });
});
