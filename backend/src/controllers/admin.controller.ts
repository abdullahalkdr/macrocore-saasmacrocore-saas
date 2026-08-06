import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';

// Matches the public pricing page (frontend/src/pages/PricingPage.tsx) — 'trial' is
// what every signup starts on, not a purchasable tier.
const PLAN_VALUES = ['trial', 'bronze', 'silver', 'gold', 'enterprise'];
const STATUS_VALUES = ['trial', 'active', 'past_due', 'suspended', 'cancelled'];

// Every tenant, for the platform-admin dashboard's companies table. No payment
// gateway is wired up yet (see docs/MIGRATION_029_subscription_enforcement.sql), so
// until one is chosen, this is also the only way to actually turn a signup into a
// paying, unblocked account — updateCompany below does that manually.
// Includes every user on each tenant (email/name/role/status) — without this, the
// companies table is just anonymous rows ("cocolab", "My Kiosk") with no way to tell
// who actually signed up or which login belongs to which row, which is exactly the
// problem reported: no way to know whose account is whose before granting a plan.
export const listCompanies = asyncHandler(async (_req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.industry, c.country, c.employee_count_range, c.plan, c.subscription_status,
            c.trial_start_date, c.trial_end_date, c.created_at,
            COALESCE(u.users, '[]'::json) AS users
     FROM companies c
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object('email', us.email, 'full_name', us.full_name, 'role', us.role, 'status', us.status) ORDER BY us.created_at ASC) AS users
       FROM users us WHERE us.company_id = c.id
     ) u ON true
     ORDER BY c.created_at DESC`
  );
  res.status(200).json({ success: true, companies: result.rows });
});

export const updateCompany = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { plan, subscription_status, trial_end_date } = req.body ?? {};

  if (plan !== undefined && !PLAN_VALUES.includes(plan)) {
    throw new AppError(400, `plan must be one of: ${PLAN_VALUES.join(', ')}`);
  }
  if (subscription_status !== undefined && !STATUS_VALUES.includes(subscription_status)) {
    throw new AppError(400, `subscription_status must be one of: ${STATUS_VALUES.join(', ')}`);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (plan !== undefined) { sets.push(`plan = $${i++}`); values.push(plan); }
  if (subscription_status !== undefined) { sets.push(`subscription_status = $${i++}`); values.push(subscription_status); }
  if (trial_end_date !== undefined) { sets.push(`trial_end_date = $${i++}`); values.push(trial_end_date); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');

  values.push(id);
  const result = await pool.query(
    `UPDATE companies SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, name, plan, subscription_status, trial_end_date`,
    values
  );
  if (!result.rows[0]) throw new AppError(404, 'Company not found');

  res.status(200).json({ success: true, company: result.rows[0] });
});

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
