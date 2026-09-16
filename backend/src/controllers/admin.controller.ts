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
import { env } from '../config/env';
// Chat 4B, Stage B4A — billing emails for the two real B2/B3 events this
// controller already implements (subscription activated, invoice issued).
// See claude/chat4b-b4a-immediate-subscription-invoice-emails-2026-09-15.md
// (project doc). Reviewed design (baseline fa379ff): enqueueEmail() is
// called strictly AFTER each transaction's own COMMIT, on the plain `pool`
// — never inside the open business transaction (see the B4A brief's
// "Transaction and failure boundaries" section) — reusing the existing
// durable email_jobs queue exactly the way verification/invitation emails
// already do elsewhere in this codebase. No second queue/worker/scheduler.
import { enqueueEmail, subscriptionActivatedEmailHtml, subscriptionInvoiceIssuedEmailHtml } from '../utils/email';
import { resolveBillingRecipients } from '../utils/billingRecipients';

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
// gateway is wired up yet (see docs/MIGRATION_029_subscription_enforcement.sql).
// Granting a real paid plan goes through activateSubscription below (it creates
// the matching subscriptions row invoicing/MRR/billing-emails all depend on);
// updateCompany below is the legacy path, now restricted to trial/status/
// trial_end_date edits only — see its own guard comment for why.
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

    // Abdullah's decision (2026-09-15, following up on the B4A production-QA
    // observation that this endpoint could set companies.plan to a paid tier
    // with no matching subscriptions row — see
    // claude/chat4b-b4a-post-commit-implementation-2026-09-15.md): a real
    // paid plan (bronze/silver/gold/enterprise) may only be granted through
    // activateSubscription, which creates the subscriptions row that
    // invoicing (B3), MRR reporting, and the billing emails (B4A) all depend
    // on. This endpoint may still move a company TO 'trial' (a downgrade/
    // reset, not a new paid grant) and may still re-save its CURRENT plan
    // value unchanged (the frontend always resends it) — only a real change
    // to a non-trial value is blocked, regardless of whether the company is
    // already "managed". This subsumes the narrower pre-existing managed-only
    // block below for the non-trial case; the managed check still applies
    // when the requested new value is 'trial' itself.
    if (plan !== undefined && plan !== previous.plan) {
      if (plan !== 'trial') {
        throw new AppError(
          409,
          "Paid plans (bronze/silver/gold/enterprise) can only be granted via Activate Subscription — it creates the matching subscriptions row this company needs for invoicing and billing emails. This endpoint can only move a company to 'trial'."
        );
      }
      if (isManaged) {
        throw new AppError(409, 'This company has an active managed subscription; its plan cannot be changed through this endpoint.');
      }
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

// Stage B3 — SELECT extended with the invoice's own immutable snapshot columns
// (invoice_number, plan, billing_interval, currency, period_start, period_end)
// so Platform Admin can render the real agreed charge and its real currency
// instead of assuming a hardcoded "KD" — see PlatformAdminPage.tsx.
export const listInvoices = asyncHandler(async (_req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT i.id, i.invoice_number, i.company_id, c.name AS company_name, i.subscription_id,
            i.plan, i.billing_interval, i.currency, i.amount, i.status,
            i.period_start, i.period_end, i.issue_date, i.due_date, i.payment_date, i.created_at
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

// Stage B3 — shapes an `invoices` row for API responses (createSubscriptionInvoice's
// 201/409 bodies and, in spirit, listInvoices' raw rows — listInvoices intentionally
// keeps returning raw SQL rows unshaped, matching its own pre-B3 convention, so this
// helper is used only where a single invoice needs the same ISO-date normalization
// shapeSubscription already gives subscriptions).
function shapeInvoice(row: Record<string, unknown> | undefined): unknown {
  if (!row?.id) return null;
  return {
    id: row.id,
    invoice_number: row.invoice_number,
    company_id: row.company_id,
    subscription_id: row.subscription_id,
    plan: row.plan,
    billing_interval: row.billing_interval,
    currency: row.currency,
    amount: row.amount,
    period_start: toIsoOrNull(row.period_start),
    period_end: toIsoOrNull(row.period_end),
    status: row.status,
    issue_date: toIsoOrNull(row.issue_date),
    due_date: toIsoOrNull(row.due_date),
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

    // Chat 4C, Stage B4B — Layer A trial-lifecycle cancellation (design v8
    // §4.6). An activation makes any still-pending trial_ending/trial_expired
    // notice for this company obsolete immediately. Exact-prefix match only
    // (starts_with(), never LIKE — 'trial_ending'/'trial_expired' both
    // contain a literal '_', an unescaped LIKE wildcard):
    // related_entity_type = 'companies' alone is NOT a sufficient
    // discriminator here, since B4A's trial_started email (auth.controller.ts)
    // shares that same related_entity_type value. Same lock, same order as
    // the `companies FOR UPDATE` above — this UPDATE only ever runs after
    // that lock is already held, so it can never race a concurrent
    // deliverTrialLifecycleJob() guard on the same company (§4.8).
    await client.query(
      `UPDATE email_jobs
       SET status = 'cancelled', updated_at = now()
       WHERE company_id = $1 AND category = 'billing' AND related_entity_type = 'companies' AND related_entity_id = $1
         AND status IN ('queued', 'temp_failed')
         AND (starts_with(dedup_key, 'billing:trial_ending:') OR starts_with(dedup_key, 'billing:trial_expired:'))`,
      [id]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const subscription = shapeSubscription(subscriptionRow) as { id: string; current_period_start: string; current_period_end: string };

  // Billing email — Chat 4B, Stage B4A. Reviewed design (baseline fa379ff):
  // strictly post-commit, never inside the transaction above — the
  // subscription row is already durably committed by this point, so a plain
  // pool-backed recipient lookup + enqueueEmail() always sees it. Started
  // immediately after COMMIT, ahead of logAudit/the response below (the
  // reviewed brief: begin post-commit notification work promptly, not behind
  // unrelated post-commit work). The whole block, and each recipient inside
  // it, is independently try/caught: a lookup, template, or enqueue failure
  // for one recipient can never affect another recipient, and none of it can
  // ever change this already-committed activation or the 201 response below.
  // The 409 "already has a live subscription" conflict path above returns
  // before this line is ever reached, so a repeated activation conflict
  // never enqueues an email.
  try {
    const billingRecipients = await resolveBillingRecipients(id);
    const billingLink = `${env.FRONTEND_URL}/account?section=billing`;
    for (const recipient of billingRecipients) {
      try {
        const { subject, html } = subscriptionActivatedEmailHtml({
          lang: recipient.preferredLanguage,
          timeZone: recipient.companyTimezone,
          plan,
          billingInterval: billing_interval,
          periodAmount: resolvedAmount,
          currency,
          currentPeriodStart: start,
          currentPeriodEnd: end,
          link: billingLink,
        });
        await enqueueEmail({
          to: recipient.email,
          subject,
          html,
          category: 'billing',
          lang: recipient.preferredLanguage,
          // Brief's exact dedup-key format for this event: event type +
          // subscription ID + recipient user ID.
          dedupKey: `billing:subscription_activated:${subscription.id}:${recipient.userId}`,
          companyId: id,
          relatedEntityType: 'subscriptions',
          relatedEntityId: subscription.id,
        });
      } catch {
        console.error('[billing email] subscription-activated enqueue failed for one recipient — the activation itself is unaffected');
      }
    }
  } catch {
    console.error('[billing email] subscription-activated recipient resolution failed — the activation itself is unaffected');
  }

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

// ---------------------------------------------------------------------------
// Stage B3 — Macrocore subscription invoice foundation. See
// claude/chat4a-b3-subscription-invoice-foundation-proposal-2026-09-15.md
// (Revision 2 + the Implementation section) for the full design. This is the
// only lifecycle step this stage implements: an already-active commercial
// subscription -> exactly one 'issued' invoice per subscription period. It
// creates an administrative billing record only — not evidence a payment was
// attempted or collected (locked rule #10) — and never updates `companies`
// or `subscriptions` (a narrower footprint than even B2's activateSubscription,
// which does update `companies`).
// ---------------------------------------------------------------------------

export const createSubscriptionInvoice = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  // Empty request body by design (locked rule #11) — every commercial value
  // (plan, billing interval, currency, amount, period) is read from the
  // company's own live subscription inside the transaction below, never
  // accepted from the caller. This endpoint introduces no new pricing/catalog
  // validation path; those values are already validated and locked in at
  // activateSubscription time.
  const client = await pool.connect();
  let invoiceRow: Record<string, unknown> | undefined;

  try {
    await client.query('BEGIN');

    // Same lock, same order, as activateSubscription/updateCompany above —
    // this endpoint and company.controller.ts's deleteMe() (refactored
    // alongside this stage) both lock the company row FIRST, so invoice
    // creation and company deletion can never deadlock against each other
    // and whichever commits first is the one the other observes.
    const companyResult = await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [id]);
    if (!companyResult.rows[0]) {
      await client.query('ROLLBACK');
      throw new AppError(404, 'Company not found');
    }

    // Eligibility is based on the commercial subscription row, never
    // `companies.subscription_status` (locked rules #1/#3) — only
    // `subscriptions.status = 'active'` may receive an invoice. `past_due`
    // is deliberately NOT eligible yet (locked rule #2: no real workflow
    // currently produces that state, so accepting it now would be
    // speculative). A company stays invoice-eligible while tenant access is
    // `suspended`/`cancelled`, provided its commercial subscription is still
    // `active` (locked rule #4) — entitlement state and billing eligibility
    // are deliberately uncoupled, which is exactly why this query never
    // looks at `companies.subscription_status` at all.
    // Locked FOR UPDATE (not just read) so a concurrent activation/plan
    // change for the same company can't be interleaved mid-transaction —
    // fresh statement after the company lock, per the same READ COMMITTED
    // lesson B2's updateCompany review already established (never fold a
    // dependent check into the same statement as the lock it depends on).
    const subResult = await client.query(
      `SELECT * FROM subscriptions WHERE company_id = $1 AND status = 'active' FOR UPDATE`,
      [id]
    );
    const subscription = subResult.rows[0];
    if (!subscription) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: 'Company has no active commercial subscription to invoice',
      });
    }

    // due_date equals issue_date exactly (locked rule #5) — generated from
    // the SAME captured instant, never two separate now()/new Date() calls
    // that could theoretically diverge. Passed as the same bound parameter
    // twice below, not recomputed.
    const issuedAt = new Date();

    try {
      const insertResult = await client.query(
        `INSERT INTO invoices
           (company_id, subscription_id, plan, billing_interval, currency, amount,
            period_start, period_end, status, issue_date, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'issued', $9, $9)
         RETURNING *`,
        // -- invoice_number is NOT in this column list — the column DEFAULT
        // (MIGRATION_083) generates it via the dedicated global sequence.
        // amount is subscription.period_amount — the exact agreed period
        // charge — never reconstructed from monthly_price (which is a
        // rounded MRR-reporting derivative only; see subscriptionLifecycle.ts).
        [
          id,
          subscription.id,
          subscription.plan,
          subscription.billing_interval,
          subscription.currency,
          subscription.period_amount,
          subscription.current_period_start,
          subscription.current_period_end,
          issuedAt,
        ]
      );
      invoiceRow = insertResult.rows[0];
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      // Only the specific B3 period-uniqueness constraint means "already
      // invoiced this period" — any other unique violation (e.g. an
      // astronomically unlikely invoice_number collision on the sequence)
      // is a real error and must not be mis-reported as this business
      // conflict; it is left to propagate and surface as a real 500.
      if (pgErr.code === '23505' && pgErr.constraint === 'invoices_one_invoice_per_period') {
        // Roll back BEFORE the recovery lookup, exactly as
        // activateSubscription already does for its own conflict path —
        // Postgres refuses any further statement on an aborted transaction,
        // and the recovery read below deliberately uses `pool.query`, never
        // the just-rolled-back `client`.
        await client.query('ROLLBACK');
        const existing = await pool.query(
          `SELECT * FROM invoices WHERE subscription_id = $1 AND period_start = $2 AND period_end = $3`,
          [subscription.id, subscription.current_period_start, subscription.current_period_end]
        );
        return res.status(409).json({
          success: false,
          error: 'An invoice already exists for this subscription period',
          existing_invoice: shapeInvoice(existing.rows[0]),
        });
      }
      throw err;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const invoice = shapeInvoice(invoiceRow) as {
    id: string;
    invoice_number: string;
    plan: string;
    billing_interval: string;
    currency: string;
    amount: number;
    period_start: string;
    period_end: string;
    issue_date: string;
    due_date: string;
  };

  // Billing email — Chat 4B, Stage B4A. Reviewed design (baseline fa379ff):
  // strictly post-commit, never inside the transaction above — same pattern
  // as activateSubscription above. Started immediately after COMMIT, ahead
  // of logAudit/the response below. The whole block, and each recipient
  // inside it, is independently try/caught: nothing here can ever affect
  // the already-committed invoice or the 201 response. The 409 "invoice
  // already exists for this period" conflict path above returns before this
  // line is ever reached, so a duplicate invoice-issuance conflict never
  // enqueues a second email for the same period.
  try {
    const billingRecipients = await resolveBillingRecipients(id);
    const billingLink = `${env.FRONTEND_URL}/account?section=billing`;
    for (const recipient of billingRecipients) {
      try {
        const { subject, html } = subscriptionInvoiceIssuedEmailHtml({
          lang: recipient.preferredLanguage,
          timeZone: recipient.companyTimezone,
          invoiceNumber: invoice.invoice_number,
          plan: invoice.plan,
          billingInterval: invoice.billing_interval,
          amount: invoice.amount,
          currency: invoice.currency,
          periodStart: invoice.period_start,
          periodEnd: invoice.period_end,
          issueDate: invoice.issue_date,
          dueDate: invoice.due_date,
          link: billingLink,
        });
        await enqueueEmail({
          to: recipient.email,
          subject,
          html,
          category: 'billing',
          lang: recipient.preferredLanguage,
          // Brief's exact dedup-key format for this event: event type +
          // invoice ID + recipient user ID.
          dedupKey: `billing:invoice_issued:${invoice.id}:${recipient.userId}`,
          companyId: id,
          relatedEntityType: 'invoices',
          relatedEntityId: invoice.id,
        });
      } catch {
        console.error('[billing email] invoice-issued enqueue failed for one recipient — the invoice itself is unaffected');
      }
    }
  } catch {
    console.error('[billing email] invoice-issued recipient resolution failed — the invoice itself is unaffected');
  }

  // Best-effort, after COMMIT — same non-transactional pattern as B2's
  // activateSubscription/updateCompany. logAudit() catches its own errors
  // internally (utils/audit.ts); an audit-write failure here can never undo
  // the invoice or change this already-decided 201 response. Not added to
  // SENSITIVE_ACTIONS, matching every other B1/B2 billing action.
  try {
    await logAudit({
      companyId: id,
      userId: null,
      action: 'admin_subscription_invoice_issued',
      entityType: 'invoices',
      entityId: invoice.id,
      req,
      oldValues: null,
      newValues: {
        invoice_number: invoiceRow?.invoice_number,
        subscription_id: invoiceRow?.subscription_id,
        plan: invoiceRow?.plan,
        billing_interval: invoiceRow?.billing_interval,
        currency: invoiceRow?.currency,
        amount: invoiceRow?.amount,
        period_start: toIsoOrNull(invoiceRow?.period_start),
        period_end: toIsoOrNull(invoiceRow?.period_end),
      },
    });
  } catch (err) {
    // logAudit currently catches its own failures, but keep the controller's
    // post-commit boundary safe if that implementation ever changes.
    console.error('invoice audit failed:', (err as Error).message);
  }

  res.status(201).json({ success: true, invoice });
});

// ---------------------------------------------------------------------------
// Stage B5 — Provider-Neutral Payment Attempt Engine. See
// claude/chat5a-b5-payment-attempt-engine-design-pass-v4-2026-09-16.md
// (approved for implementation, with the release-owner's numbered
// clarifications) for the full design. A payment_attempts row is an
// administrative record of an attempt to collect on an already-'issued'
// invoice — creating or failing one is NEVER proof of payment, and this
// stage issues zero UPDATE/DELETE against `invoices`, `subscriptions`, or
// `companies`. requireAdminKey-gated only (see admin.routes.ts); there is no
// tenant-facing visibility of payment attempts anywhere in this stage.
// ---------------------------------------------------------------------------

// Never includes idempotency_key (locked design rule) — every response and
// every audit row built from this helper only ever exposes the fields a
// payment_attempts row is meant to expose externally.
function shapePaymentAttempt(row: Record<string, unknown> | undefined): unknown {
  if (!row?.id) return null;
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    company_id: row.company_id,
    subscription_id: row.subscription_id,
    amount: row.amount,
    currency: row.currency,
    plan: row.plan,
    billing_interval: row.billing_interval,
    period_start: toIsoOrNull(row.period_start),
    period_end: toIsoOrNull(row.period_end),
    status: row.status,
    created_at: toIsoOrNull(row.created_at),
    failed_at: toIsoOrNull(row.failed_at),
  };
}

export const createPaymentAttempt = asyncHandler(async (req: Request, res: Response) => {
  const { invoiceId } = req.params;
  const rawKey = (req.body ?? {}).idempotency_key;
  const trimmedKey = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!trimmedKey || trimmedKey.length > 100) {
    throw new AppError(400, 'idempotency_key is required and must be 1-100 characters after trimming');
  }

  // Idempotent-replay check BEFORE opening a transaction, on the plain pool
  // — a caller that retries the exact same request (e.g. after a network
  // timeout) with the same key gets back the SAME attempt it already
  // created, never a second row. This is a fast-path only; the real,
  // concurrency-safe guarantee is the database's own global UNIQUE
  // constraint (payment_attempts_idempotency_key_unique) plus the
  // fixed-order 23505 recovery below — this check can never be relied on
  // alone under concurrent requests.
  const existing = await pool.query(
    `SELECT *, invoice_id = $2::uuid AS same_invoice
     FROM payment_attempts WHERE idempotency_key = $1`,
    [trimmedKey, invoiceId]
  );
  if (existing.rows[0]) {
    if (existing.rows[0].same_invoice) {
      return res.status(200).json({ success: true, payment_attempt: shapePaymentAttempt(existing.rows[0]) });
    }
    return res.status(409).json({ success: false, error: 'This idempotency key was already used for a different invoice' });
  }

  // Single checked-out client for the whole transaction, same pattern as
  // activateSubscription/createSubscriptionInvoice above. Always released in
  // `finally`, whichever way the try block exits.
  const client = await pool.connect();
  let attemptRow: Record<string, unknown> | undefined;

  try {
    await client.query('BEGIN');

    // Locks the invoice row first — the only lock this endpoint ever takes.
    // No lock is taken on companies or subscriptions; a payment attempt
    // never contends with activateSubscription/createSubscriptionInvoice's
    // own company-row-first lock, and there is no company-deletion code
    // path to deadlock against either (invoices themselves are RESTRICT-
    // protected from deletion once any attempt exists on them — see
    // MIGRATION_084 Part B).
    const invoiceResult = await client.query(`SELECT id, status FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
    const invoice = invoiceResult.rows[0];
    if (!invoice) {
      await client.query('ROLLBACK');
      throw new AppError(404, 'Invoice not found');
    }
    // Only an 'issued' invoice is eligible. invoices_status_valid's CHECK
    // (status IN ('issued')) makes any other value structurally impossible
    // in this database today — this check is deliberately kept anyway as
    // forward-defensive code for whenever a future stage widens that CHECK
    // (e.g. adding 'void'), exactly the same "grows only when a real
    // transition exists" discipline B2/B3 already followed for their own
    // status columns.
    if (invoice.status !== 'issued') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Invoice is not eligible for a payment attempt' });
    }

    try {
      // INSERT ... SELECT — every commercial/snapshot value is read straight
      // from the invoice row inside this same statement, never accepted from
      // the request body and never touched by JS arithmetic (locked design
      // rule: no floating-point money math anywhere in this stage).
      const insertResult = await client.query(
        `INSERT INTO payment_attempts
           (invoice_id, company_id, subscription_id, amount, currency, plan,
            billing_interval, period_start, period_end, idempotency_key, status)
         SELECT id, company_id, subscription_id, amount, currency, plan,
                billing_interval, period_start, period_end, $2, 'initiated'
         FROM invoices WHERE id = $1
         RETURNING *`,
        [invoiceId, trimmedKey]
      );
      attemptRow = insertResult.rows[0];
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      // Fixed-order recovery on ANY unique violation — never branch on which
      // constraint name Postgres happens to report first (locked design
      // rule). Roll back BEFORE the recovery lookups, exactly as
      // activateSubscription/createSubscriptionInvoice already do for their
      // own conflict paths; the recovery lookups below deliberately use
      // `pool`, never the just-rolled-back `client`.
      if (pgErr.code === '23505') {
        await client.query('ROLLBACK');
        const existing2 = await pool.query(
          `SELECT *, invoice_id = $2::uuid AS same_invoice
           FROM payment_attempts WHERE idempotency_key = $1`,
          [trimmedKey, invoiceId]
        );
        if (existing2.rows[0]) {
          if (existing2.rows[0].same_invoice) {
            return res.status(200).json({ success: true, payment_attempt: shapePaymentAttempt(existing2.rows[0]) });
          }
          return res.status(409).json({ success: false, error: 'This idempotency key was already used for a different invoice' });
        }
        const activeExisting = await pool.query(
          `SELECT * FROM payment_attempts WHERE invoice_id = $1 AND status = 'initiated'`,
          [invoiceId]
        );
        if (activeExisting.rows[0]) {
          return res.status(409).json({
            success: false,
            error: 'This invoice already has an active payment attempt',
            existing_attempt: shapePaymentAttempt(activeExisting.rows[0]),
          });
        }
        // Neither recovery lookup explains the violation — an astronomically
        // unlikely id collision or similar genuine error. Left to propagate,
        // never mis-reported as one of the two known business conflicts.
        throw err;
      }
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const attempt = shapePaymentAttempt(attemptRow) as { id: string };

  // Best-effort, after COMMIT — same non-transactional pattern as every
  // other billing action in this file (logAudit catches its own errors
  // internally; a failure here can never undo the already-committed
  // attempt or change this 201 response). Never includes idempotency_key
  // (locked design rule) and is not added to SENSITIVE_ACTIONS, matching
  // every other B1-B4 billing action.
  try {
    await logAudit({
      companyId: attemptRow?.company_id as string,
      userId: null,
      action: 'admin_payment_attempt_initiated',
      entityType: 'payment_attempts',
      entityId: attempt.id,
      req,
      oldValues: null,
      newValues: {
        invoice_id: attemptRow?.invoice_id,
        company_id: attemptRow?.company_id,
        subscription_id: attemptRow?.subscription_id,
        amount: attemptRow?.amount,
        currency: attemptRow?.currency,
        plan: attemptRow?.plan,
        billing_interval: attemptRow?.billing_interval,
        period_start: toIsoOrNull(attemptRow?.period_start),
        period_end: toIsoOrNull(attemptRow?.period_end),
        status: 'initiated',
      },
    });
  } catch (err) {
    // logAudit currently catches its own failures, but keep this
    // controller's post-commit boundary safe if that implementation ever
    // changes — same defensive pattern createSubscriptionInvoice already uses.
    console.error('payment attempt audit failed:', (err as Error).message);
  }

  res.status(201).json({ success: true, payment_attempt: attempt });
});

// Read-only. 404s when the invoice itself doesn't exist; returns an empty
// array (not 404) when the invoice exists but has no attempts yet.
export const listPaymentAttempts = asyncHandler(async (req: Request, res: Response) => {
  const { invoiceId } = req.params;
  const invoiceExists = await pool.query(`SELECT 1 FROM invoices WHERE id = $1`, [invoiceId]);
  if (!invoiceExists.rows[0]) {
    throw new AppError(404, 'Invoice not found');
  }
  const result = await pool.query(
    `SELECT * FROM payment_attempts WHERE invoice_id = $1 ORDER BY created_at DESC`,
    [invoiceId]
  );
  res.status(200).json({ success: true, attempts: result.rows.map(shapePaymentAttempt) });
});

// The only transition this stage exposes: 'initiated' -> 'failed'. A single
// guarded UPDATE, atomic on its own — no explicit transaction needed. Never
// sets failed_at itself; payment_attempts_guard_mutation_trg (MIGRATION_084)
// is the sole authority that stamps it with PostgreSQL transaction time.
// A repeat call on an already-'failed'
// attempt returns 409, never a replayed 200 — mark-failed is not an
// idempotent-key operation like create is; there is nothing to replay.
export const markPaymentAttemptFailed = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await pool.query(
    `UPDATE payment_attempts SET status = 'failed' WHERE id = $1 AND status = 'initiated' RETURNING *`,
    [id]
  );
  const row = result.rows[0];
  if (row) {
    // Best-effort, after the UPDATE has committed (autocommit — this is a
    // single statement, not inside an explicit BEGIN/COMMIT). Never includes
    // idempotency_key; not added to SENSITIVE_ACTIONS, matching
    // admin_payment_attempt_initiated above.
    try {
      await logAudit({
        companyId: row.company_id,
        userId: null,
        action: 'admin_payment_attempt_failed',
        entityType: 'payment_attempts',
        entityId: row.id,
        req,
        oldValues: { status: 'initiated' },
        newValues: { status: 'failed', failed_at: toIsoOrNull(row.failed_at) },
      });
    } catch (err) {
      console.error('payment attempt failure audit failed:', (err as Error).message);
    }
    return res.status(200).json({ success: true, payment_attempt: shapePaymentAttempt(row) });
  }

  const existingResult = await pool.query(`SELECT id, status FROM payment_attempts WHERE id = $1`, [id]);
  const existingRow = existingResult.rows[0];
  if (!existingRow) {
    throw new AppError(404, 'Payment attempt not found');
  }
  return res.status(409).json({
    success: false,
    error: `Payment attempt is already '${existingRow.status}'; no transition applied`,
  });
});
