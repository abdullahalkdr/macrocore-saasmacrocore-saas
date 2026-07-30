import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { date } = req.query;

  const params: unknown[] = [companyId];
  let where = 'company_id = $1';
  if (typeof date === 'string') {
    params.push(date);
    where += ` AND created_at::date = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT id, category, amount, description, created_at, created_by FROM expenses WHERE ${where} ORDER BY created_at DESC`,
    params
  );
  res.status(200).json({ success: true, expenses: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { category, amount, description, receipt_image } = req.body ?? {};

  if (typeof amount !== 'number' || amount <= 0) throw new AppError(400, 'amount must be a positive number');

  const result = await pool.query(
    `INSERT INTO expenses (company_id, category, amount, description, receipt_image, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, category, amount, description, created_at`,
    [companyId, category ?? null, amount, description ?? null, receipt_image ?? null, req.auth!.userId]
  );
  const expense = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'expense_created', entityType: 'expenses', entityId: expense.id, req });

  res.status(201).json({ success: true, expense });
});
