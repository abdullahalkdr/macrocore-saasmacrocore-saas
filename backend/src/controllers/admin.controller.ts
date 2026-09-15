import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

// Matches the public pricing page (frontend/src/pages/PricingPage.tsx) — 'trial' is
// what every signup starts on, not a purchasable tier.
const PLAN_VALUES = ['trial', 'bronze', 'silver', 'gold', 'enterprise'];
const STATUS_VALUES = ['trial', 'active', 'past_due', 'suspended', 'cancelled'];

// Pure — no DB, no I/O, unit-testable without a live Postgres connection. Takes the
// single RETURNING row from updateCompany's CTE (which carries both the pre-update
// "previous_*" values and the post-update values from ONE atomic statement) and
// shapes it into the {oldValues, newValues} pair logAudit() expects. Always returns
// all three billing fields in both snapshots, even when a PATCH only touched one of
// them and even when nothing actually changed (see updateCompany for why a no-op
// PATCH is still logged) — a full snapshot, not a partial diff, matches how every
// other logAudit() call site in this codebase already passes oldValues/newValues
// (e.g. users.controller.ts's role-change logging).
export function buildBillingAuditSnapshot(row: {
  previous_plan: unknown;
  previous_subscription_status: unknown;
  previous_trial_end_date: unknown;
  plan: unknown;
  subscription_status: unknown;
  trial_end_date: unknown;
}): {
  oldValues: { plan: unknown; subscription_status: unknown; trial_end_date: unknown };
  newValues: { plan: unknown; subscription_status: unknown; trial_end_date: unknown };
} {
  return {
    oldValues: {
      plan: row.previous_plan,
      subscription_status: row.previous_subscription_status,
      trial_end_date: row.previous_trial_end_date,
    },
    newValues: {
      plan: row.plan,
      subscription_status: row.subscription_status,
      trial_end_date: row.trial_end_date,
    },
  };
}

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

  // Single atomic statement: FOR UPDATE inside the CTE locks the row before the
  // outer UPDATE runs, and both execute as one round-trip to Postgres — there is no
  // gap between "read the previous values" and "write the new ones" for a
  // concurrent PATCH to the same company to land in. RETURNING carries both the
  // pre-update ("previous_*") and post-update values back on the same row, so no
  // second query is needed to know what changed. No BEGIN/COMMIT needed — a single
  // statement is already its own transaction.
  const result = await pool.query(
    `WITH previous AS (
       SELECT id, plan, subscription_status, trial_end_date
       FROM companies
       WHERE id = $${i}
       FOR UPDATE
     )
     UPDATE companies
     SET ${sets.join(', ')}
     FROM previous
     WHERE companies.id = previous.id
     RETURNING companies.id, companies.name, companies.plan, companies.subscription_status, companies.trial_end_date,
               previous.plan AS previous_plan, previous.subscription_status AS previous_subscription_status,
               previous.trial_end_date AS previous_trial_end_date`,
    values
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, 'Company not found');

  // Best-effort audit trail only — see utils/audit.ts. This is a SEPARATE
  // statement from the CTE UPDATE above, not part of the same atomic unit — only
  // the previous-values-read + write inside that CTE is atomic. logAudit() runs
  // its own pool.query, catches its own errors internally, and never throws, so
  // if its INSERT fails, the companies UPDATE above (already committed by this
  // point) is never undone and the HTTP response below is unaffected — but the
  // request DOES wait for logAudit()'s promise to settle (success or caught
  // failure) before responding; "isolated" means isolated in outcome, not
  // zero-latency. This is an "Audit manual subscription changes" record, not a
  // guaranteed lifecycle engine or a recovery source for billing notifications.
  // The CTE serializes updates to the same company. Audit insertion happens
  // after that statement commits, so audit row order is not guaranteed to
  // match update order, even for the same company.
  // There is no per-user actor to record: requireAdminKey authenticates a single
  // shared secret, not a person (see middleware/requireAdminKey.ts), so userId is
  // always null for this action — that is disclosed here, not a bug to fix later.
  // Logged unconditionally, even when the PATCH changed nothing, because the
  // auditable event is "an admin used this endpoint on this company", not "a
  // value changed" — a no-op PATCH is still something worth a trail, and is
  // itself just an administrative update request, not a real subscription
  // transition (it must never be read as one, e.g. as a future change-email
  // trigger). 'admin_company_billing_updated' is deliberately NOT added to
  // SENSITIVE_ACTIONS (utils/audit.ts): that set drives the separate field-diff
  // table and the WhatsApp alert pipeline, neither of which this stage implements
  // or was asked to — this is a targeted B1 addition, not a general expansion of
  // the historical sensitive-action scope.
  const { oldValues, newValues } = buildBillingAuditSnapshot(row);
  await logAudit({
    companyId: row.id,
    userId: null,
    action: 'admin_company_billing_updated',
    entityType: 'companies',
    entityId: row.id,
    req,
    oldValues,
    newValues,
  });

  res.status(200).json({
    success: true,
    company: {
      id: row.id,
      name: row.name,
      plan: row.plan,
      subscription_status: row.subscription_status,
      trial_end_date: row.trial_end_date,
    },
  });
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
