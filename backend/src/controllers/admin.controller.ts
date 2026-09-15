import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import {
  ACTIVATABLE_PLANS,
  BILLING_INTERVALS,
  SUPPORTED_CURRENCIES,
  resolvePeriodAmount,
  normalizeToMonthlyPrice,
  computePeriodBounds,
} from '../utils/subscriptionLifecycle';
import { APPROVED_PRICING_CATALOG } from '../config/pricingCatalog';

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

// ---------------------------------------------------------------------------
// Stage B2 — "managed" guard shared between updateCompany (below) and
// activateSubscription/getCompanySubscription (further below). A company is
// "managed" the moment it has a subscriptions row with status IN
// ('active','past_due') — computed by query, not a stored column. See
// claude/chat4a-b2-subscription-billing-foundation-proposal-2026-09-15.md §2.
// (The two literal statuses are inlined directly in each SQL string below
// rather than interpolated from a shared JS array, to keep every query a
// plain parameterized statement — no array-to-SQL-list interpolation.)
// ---------------------------------------------------------------------------

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

  // B2 uses the same company-row lock as activation, then checks subscriptions in
  // a separate statement. Under READ COMMITTED that second statement gets a fresh
  // snapshot after any activation we waited for has committed. Keeping the managed
  // check inside the original one-statement CTE was unsafe: its statement snapshot
  // could predate the transaction that released the row lock, allowing a stale
  // "unmanaged" decision and a plan change immediately after activation.
  const client = await pool.connect();
  let row: { id: string; name: string; plan: unknown; subscription_status: unknown; trial_end_date: string | null };
  let previous: { plan: unknown; subscription_status: unknown; trial_end_date: string | null };
  try {
    await client.query('BEGIN');
    const previousResult = await client.query(
      `SELECT id, name, plan, subscription_status, trial_end_date
       FROM companies WHERE id = $1 FOR UPDATE`,
      [id]
    );
    previous = previousResult.rows[0];
    if (!previous) throw new AppError(404, 'Company not found');

    const managedResult = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM subscriptions
         WHERE company_id = $1 AND status IN ('active','past_due')
       ) AS is_managed`,
      [id]
    );
    const isManaged = managedResult.rows[0]?.is_managed === true;
    if (isManaged && plan !== undefined && plan !== previous.plan) {
      throw new AppError(409, 'This company has an active managed subscription; its plan cannot be changed through this endpoint.');
    }
    if (isManaged && subscription_status === 'trial') {
      throw new AppError(409, "subscription_status cannot be set to 'trial' while this company has an active managed subscription.");
    }

    const result = await client.query(
      `UPDATE companies SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING id, name, plan, subscription_status, trial_end_date`,
      values
    );
    row = result.rows[0];
    if (!row) throw new AppError(404, 'Company not found');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Best-effort audit trail only — see utils/audit.ts. This is a SEPARATE
  // statement from the transaction above, not part of the same atomic unit. logAudit() runs
  // its own pool.query, catches its own errors internally, and never throws, so
  // if its INSERT fails, the companies UPDATE above (already committed by this
  // point) is never undone and the HTTP response below is unaffected — but the
  // request DOES wait for logAudit()'s promise to settle (success or caught
  // failure) before responding; "isolated" means isolated in outcome, not
  // zero-latency. This is an "Audit manual subscription changes" record, not a
  // guaranteed lifecycle engine or a recovery source for billing notifications.
  // The transaction serializes updates to the same company. Audit insertion happens
  // after it commits, so audit row order is not guaranteed to
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
  // the historical sensitive-action scope. B2 does not add its own new action to
  // SENSITIVE_ACTIONS either — see activateSubscription below.
  const { oldValues, newValues } = buildBillingAuditSnapshot({
    ...row,
    previous_plan: previous.plan,
    previous_subscription_status: previous.subscription_status,
    previous_trial_end_date: previous.trial_end_date,
  } as Parameters<typeof buildBillingAuditSnapshot>[0]);
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
    `SELECT s.id, s.company_id, c.name AS company_name, s.plan, s.status, s.currency, s.period_amount,
            s.monthly_price, s.billing_interval, s.auto_renew, s.next_billing_date, s.created_at
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
  // B2: segmented by currency, never summed across currencies (a mixed-currency
  // SUM is not a meaningful number) — see B2 proposal, review point 4. Returns
  // one row per currency that actually has an active subscription; an empty
  // array is valid and expected when no active subscriptions exist.
  const mrrByCurrency = await pool.query(
    `SELECT currency, COALESCE(SUM(monthly_price), 0)::float AS mrr
     FROM subscriptions
     WHERE status = 'active'
     GROUP BY currency
     ORDER BY currency`
  );

  res.status(200).json({
    success: true,
    total_companies: totals.rows[0].total_companies,
    by_plan_and_status: companies.rows,
    mrr_by_currency: mrrByCurrency.rows,
  });
});

// ---------------------------------------------------------------------------
// Stage B2 — subscription activation (the only lifecycle transition this
// stage implements: (none) -> active). See the B2 proposal doc for full
// design/rationale. Administrative record only — NOT evidence of payment
// collection, does not touch `invoices`, does not enforce
// current_period_end. No cancel/change-plan/past_due transition exists yet.
// ---------------------------------------------------------------------------

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function shapeSubscription(row: Record<string, unknown> | undefined): unknown {
  if (!row?.id) return null;
  return {
    id: row.id,
    company_id: row.company_id,
    plan: row.plan,
    status: row.status,
    currency: row.currency,
    period_amount: row.period_amount,
    monthly_price: row.monthly_price,
    billing_interval: row.billing_interval,
    current_period_start: toIsoOrNull(row.current_period_start),
    current_period_end: toIsoOrNull(row.current_period_end),
    auto_renew: row.auto_renew,
    created_at: toIsoOrNull(row.created_at),
  };
}

export const activateSubscription = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { plan, billing_interval, currency, period_amount } = req.body ?? {};

  if (!ACTIVATABLE_PLANS.includes(plan)) {
    throw new AppError(400, `plan must be one of: ${ACTIVATABLE_PLANS.join(', ')}`);
  }
  if (!BILLING_INTERVALS.includes(billing_interval)) {
    throw new AppError(400, `billing_interval must be one of: ${BILLING_INTERVALS.join(', ')}`);
  }
  if (plan === 'enterprise' && billing_interval !== 'annual') {
    throw new AppError(400, 'enterprise subscriptions must use annual billing');
  }
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new AppError(400, `currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`);
  }
  if (currency !== APPROVED_PRICING_CATALOG.currency) {
    throw new AppError(400, `currency must be ${APPROVED_PRICING_CATALOG.currency}`);
  }

  // Validates period_amount (finite/positive/precision/storage range) and, if
  // APPROVED_PRICING_CATALOG has an entry for [plan][interval], enforces it —
  // see utils/subscriptionLifecycle.ts. Enterprise remains a manually quoted
  // annual contract; standard plans use the approved USD catalog.
  const resolvedAmount = resolvePeriodAmount(plan, billing_interval, currency, period_amount, APPROVED_PRICING_CATALOG);
  const monthlyPrice = normalizeToMonthlyPrice(resolvedAmount, billing_interval);
  const { start, end } = computePeriodBounds(billing_interval);

  // Single checked-out client for the whole transaction (BEGIN through
  // COMMIT/ROLLBACK) — unlike updateCompany above, this needs more than one
  // statement to stay atomic (lock -> insert -> sync companies), so a bare
  // pool.query() per statement would not share one transaction. Always
  // released in `finally`, whichever way the try block exits.
  const client = await pool.connect();
  let subscriptionRow: Record<string, unknown> | undefined;

  try {
    await client.query('BEGIN');

    // Same lock, same order, as updateCompany's guard above — the two
    // endpoints can never deadlock against each other, and whichever one
    // gets here first always finishes (commit or rollback) before the other
    // proceeds past this line.
    const companyResult = await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [id]);
    if (!companyResult.rows[0]) {
      await client.query('ROLLBACK');
      throw new AppError(404, 'Company not found');
    }

    try {
      const insertResult = await client.query(
        `INSERT INTO subscriptions
           (company_id, plan, status, currency, period_amount, monthly_price,
            billing_interval, current_period_start, current_period_end, auto_renew, next_billing_date)
         VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, false, ($8 AT TIME ZONE 'UTC'))
         RETURNING *`,
        [id, plan, currency, resolvedAmount, monthlyPrice, billing_interval, start, end]
      );
      subscriptionRow = insertResult.rows[0];
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      // Only the specific partial-unique-index violation means "already
      // managed" — any other unique violation (astronomically unlikely; e.g.
      // a primary-key collision) is a real error and must not be
      // mis-reported as this business conflict.
      if (pgErr.code === '23505' && pgErr.constraint === 'subscriptions_one_live_per_company') {
        // The transaction is aborted after a failed statement — Postgres
        // refuses any further statement until ROLLBACK. Must roll back
        // BEFORE the recovery lookup below, not after. (Missing this was
        // caught during this stage's own verification: releasing a pool
        // client whose transaction is still aborted corrupts that
        // connection for whichever unrelated request draws it next.)
        await client.query('ROLLBACK');
        const existing = await pool.query(
          `SELECT * FROM subscriptions WHERE company_id = $1 AND status IN ('active','past_due') LIMIT 1`,
          [id]
        );
        return res.status(409).json({
          success: false,
          error: 'Company already has a live subscription',
          existing_subscription: shapeSubscription(existing.rows[0]),
        });
      }
      throw err;
    }

    await client.query(
      `UPDATE companies SET plan = $1, subscription_status = 'active' WHERE id = $2`,
      [plan, id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const subscription = shapeSubscription(subscriptionRow) as { id: string; current_period_start: string; current_period_end: string };

  // Best-effort, after COMMIT, same non-transactional pattern as B1's
  // updateCompany — a logAudit() failure here never undoes the activation.
  // Not added to SENSITIVE_ACTIONS, matching 'admin_company_billing_updated'.
  await logAudit({
    companyId: id,
    userId: null,
    action: 'admin_subscription_activated',
    entityType: 'subscriptions',
    entityId: subscription.id,
    req,
    oldValues: null,
    newValues: {
      plan,
      currency,
      period_amount: resolvedAmount,
      billing_interval,
      current_period_start: subscription.current_period_start,
      current_period_end: subscription.current_period_end,
    },
  });

  res.status(201).json({
    success: true,
    subscription,
    company: { id, plan, subscription_status: 'active' },
  });
});

// Read-only recovery/lookup endpoint — see B2 proposal §3.5. Returns the
// company's current live subscription, or null. A null result means either
// no live subscription exists yet, OR an activation for this company is
// still in flight (its transaction hasn't committed at the moment of this
// read) — it is NOT proof that a prior activation attempt never landed.
// Safety against a duplicate always comes from the unique index + row lock
// in activateSubscription, never from this endpoint's result.
export const getCompanySubscription = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await pool.query(
    `SELECT c.id AS company_exists, s.*
     FROM companies c
     LEFT JOIN LATERAL (
       SELECT * FROM subscriptions
       WHERE company_id = c.id AND status IN ('active','past_due')
       ORDER BY created_at DESC LIMIT 1
     ) s ON true
     WHERE c.id = $1`,
    [id]
  );
  if (!result.rows[0]) {
    throw new AppError(404, 'Company not found');
  }
  res.status(200).json({ success: true, subscription: shapeSubscription(result.rows[0]) });
});
