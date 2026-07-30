import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';

export const listSubscriptions = asyncHandler(async (_req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT s.id, s.company_id, c.name AS company_name, s.plan, s.status, s.monthly_price, s.auto_renew, s.next_billing_date, s.created_at
     FROM subscriptions s JOIN companies c ON c.id = s.company_id
     ORDER BY s.created_at DESC`
  );
  res.status(200).json({ success: true, subscriptions: result.rows });
});

export const listInvoices = asyncHandler(async (_req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT i.id, i.company_id, c.name AS company_name, i.amount, i.status, i.issue_date, i.due_date, i.payment_date
     FROM invoices i JOIN companies c ON c.id = i.company_id
     ORDER BY i.created_at DESC`
  );
  res.status(200).json({ success: true, invoices: result.rows });
});

export const stats = asyncHandler(async (_req: Request, res: Response) => {
  const companies = await pool.query(
    `SELECT plan, subscription_status, COUNT(*)::int AS n FROM companies GROUP BY plan, subscription_status`
  );
  const totals = await pool.query(`SELECT COUNT(*)::int AS total_companies FROM companies`);
  const mrr = await pool.query(
    `SELECT COALESCE(SUM(monthly_price), 0)::float AS mrr FROM subscriptions WHERE status = 'active'`
  );

  res.status(200).json({
    success: true,
    total_companies: totals.rows[0].total_companies,
    by_plan_and_status: companies.rows,
    mrr: mrr.rows[0].mrr,
  });
});
