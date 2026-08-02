import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

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
            e.created_at, e.created_by, l.name AS location_name, u.full_name AS created_by_name
     FROM expenses e
     LEFT JOIN locations l ON l.id = e.location_id
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

  const result = await pool.query(
    `INSERT INTO expenses (company_id, category, amount, description, receipt_image, location_id, expense_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, category, amount, description, location_id, expense_date, created_at`,
    [
      companyId,
      category ?? null,
      amount,
      description ?? null,
      receipt_image ?? null,
      location_id ?? null,
      expense_date ?? null,
      req.auth!.userId,
    ]
  );
  const expense = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'expense_created', entityType: 'expenses', entityId: expense.id, req });

  res.status(201).json({ success: true, expense });
});

// Admin/manager only (see routes) — lets a manager fix a miskeyed amount/category/date
// after the fact instead of deleting and re-entering.
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { category, amount, description, receipt_image, location_id, expense_date } = req.body ?? {};

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
     RETURNING id, category, amount, description, location_id, expense_date, created_at`,
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

  const result = await pool.query('DELETE FROM expenses WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (result.rows.length === 0) throw new AppError(404, 'Expense not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'expense_deleted', entityType: 'expenses', entityId: id as string, req });

  res.status(200).json({ success: true });
});
