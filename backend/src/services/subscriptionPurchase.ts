// Stage B7 — Trial-to-paid customer self-service subscription checkout.
// Binding design: claude/chat7a-b7-customer-subscription-checkout-design-pass-v3-2026-09-24.md
// (approved), with the two release-owner implementation clarifications.
//
// Every transaction in this module follows ONE global lock order:
//
//   companies -> subscription_purchases -> subscriptions -> invoices
//             -> payment_attempts -> payment_checkout_sessions
//
// B5/B6 paths that never take the company lock (createPaymentAttempt,
// markPaymentAttemptFailed, admin createCheckoutSession) acquire a strict
// suffix of this order, so no lock cycle is possible (design v3 §9.1).
//
// Clock rule (design v3 R1): no time anchor or deadline decision here ever uses
// transaction `now()` — a transaction can wait on `companies FOR UPDATE` for an
// unbounded time, so `now()` can be stale. The confirmation instant is captured
// ONCE with clock_timestamp() after all locks, stored as the pending
// subscription's current_period_start, and every derived value is computed in
// SQL from that stored column. Every expiry decision is a fresh
// `SELECT clock_timestamp() < expires_at` statement issued AFTER the relevant
// locks are held. No timestamp is ever read into JavaScript and sent back.
//
// Money rule (design v3 §7.1): the charge arrives as canonical decimal TEXT
// from config/pricingCatalog.ts and is passed to PostgreSQL as `$n::numeric`;
// every read-back uses ::text. No JavaScript number ever holds a B7 charge.
//
// No function in this module calls logAudit() or enqueueEmail(). Callers write
// audit rows post-commit from the snapshots returned here; B7 sends no email.

import type { PoolClient } from 'pg';
import { CHECKOUT_WINDOW_MINUTES } from '../config/billing';
import { settleOutcome, SettleOutcomeResult } from './paymentSettlement';
import type { BillingInterval, StandardPlan } from '../utils/subscriptionLifecycle';

// Minimal structural types so the same code runs against a real pg Pool /
// PoolClient and the disposable-DB smoke's adapters.
export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface Connectable extends Queryable {
  connect: () => Promise<Queryable & { release: () => void }>;
}

export class PurchaseError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export type VoidReason = 'superseded' | 'expired_superseded' | 'expired_admin_action';

export interface VoidSnapshot {
  purchase_id: string;
  reason: VoidReason;
  invoice_id: string;
  invoice_number: string;
  subscription_id: string;
  company_id: string;
  cancelled_payment_attempt_ids: string[];
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function expectOneRow(result: { rows: any[] }, what: string): any {
  if (result.rows.length !== 1) {
    throw new Error(`subscriptionPurchase: expected exactly one row for ${what}, got ${result.rows.length}`);
  }
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Shared trial-email cancellation (moved verbatim from admin.controller.ts's
// activateSubscription, Chat 4C / Stage B4B Layer A). Both the manual
// activation path and the self-service trusted-success path call this, inside
// their own transaction, after the company lock is held.
// ---------------------------------------------------------------------------
export async function cancelTrialLifecycleEmails(client: Queryable, companyId: string): Promise<void> {
  await client.query(
    `UPDATE email_jobs
       SET status = 'cancelled', updated_at = now()
       WHERE company_id = $1 AND category = 'billing' AND related_entity_type = 'companies' AND related_entity_id = $1
         AND status IN ('queued', 'temp_failed')
         AND (starts_with(dedup_key, 'billing:trial_ending:') OR starts_with(dedup_key, 'billing:trial_expired:'))`,
    [companyId]
  );
}

// ---------------------------------------------------------------------------
// Open-purchase lookup. Caller must already hold companies FOR UPDATE.
// ---------------------------------------------------------------------------
export interface LockedOpenPurchase {
  id: string;
  company_id: string;
  subscription_id: string;
  invoice_id: string;
  expires_at: string | null;
  target_plan: string;
  target_interval: string;
  unexpired: boolean;
}

export async function lockOpenPurchase(client: Queryable, companyId: string): Promise<LockedOpenPurchase | null> {
  const result = await client.query(
    `SELECT sp.id, sp.company_id, sp.subscription_id, sp.invoice_id, sp.expires_at,
            s.plan AS target_plan, s.billing_interval AS target_interval
     FROM subscription_purchases sp
     JOIN subscriptions s ON s.id = sp.subscription_id
     WHERE sp.company_id = $1 AND sp.status = 'open'
     FOR UPDATE OF sp`,
    [companyId]
  );
  const row = result.rows[0];
  if (!row) return null;
  // Expiry decision: a SEPARATE statement, issued only after the row lock is
  // held, on the real clock (never transaction now()).
  const clock = await client.query(
    `SELECT clock_timestamp() < expires_at AS unexpired FROM subscription_purchases WHERE id = $1`,
    [row.id]
  );
  return {
    id: row.id,
    company_id: row.company_id,
    subscription_id: row.subscription_id,
    invoice_id: row.invoice_id,
    expires_at: toIsoOrNull(row.expires_at),
    target_plan: row.target_plan,
    target_interval: row.target_interval,
    unexpired: clock.rows[0]?.unexpired === true,
  };
}

// ---------------------------------------------------------------------------
// voidPurchaseChain (design v3 §9.6) — the SINGLE void implementation.
// Preconditions: the caller already holds companies FOR UPDATE and the
// purchase's subscription_purchases row FOR UPDATE. Re-verifies status='open'
// under that lock, then continues the global lock order.
// ---------------------------------------------------------------------------
export async function voidPurchaseChain(client: Queryable, purchaseId: string, reason: VoidReason): Promise<VoidSnapshot> {
  const purchase = (
    await client.query(
      `SELECT id, company_id, subscription_id, invoice_id, status FROM subscription_purchases WHERE id = $1 FOR UPDATE`,
      [purchaseId]
    )
  ).rows[0];
  if (!purchase) throw new Error(`voidPurchaseChain: purchase ${purchaseId} not found`);
  if (purchase.status !== 'open') {
    throw new Error(`voidPurchaseChain: purchase ${purchaseId} is '${purchase.status}', not 'open'`);
  }

  // subscriptions -> invoices -> payment_attempts -> payment_checkout_sessions
  expectOneRow(
    await client.query(`SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE`, [purchase.subscription_id]),
    'pending subscription lock'
  );
  const invoice = expectOneRow(
    await client.query(`SELECT id, invoice_number, status FROM invoices WHERE id = $1 FOR UPDATE`, [purchase.invoice_id]),
    'invoice lock'
  );
  const attempts = (
    await client.query(
      `SELECT id, status FROM payment_attempts WHERE invoice_id = $1 ORDER BY created_at, id FOR UPDATE`,
      [purchase.invoice_id]
    )
  ).rows;

  const cancelled: string[] = [];
  for (const attempt of attempts) {
    if (attempt.status !== 'initiated') continue;
    const session = (
      await client.query(
        `SELECT id, status FROM payment_checkout_sessions WHERE payment_attempt_id = $1 FOR UPDATE`,
        [attempt.id]
      )
    ).rows[0];
    // settleOutcome is the sole writer of terminal attempt/session status.
    await settleOutcome(client as PoolClient, {
      attempt: { id: attempt.id },
      session: session ? { id: session.id } : null,
      invoice: null,
      outcome: 'cancelled',
    });
    cancelled.push(attempt.id);
  }

  expectOneRow(
    await client.query(`UPDATE invoices SET status = 'void' WHERE id = $1 AND status = 'issued' RETURNING id`, [invoice.id]),
    'invoice issued -> void'
  );
  expectOneRow(
    await client.query(
      `UPDATE subscriptions SET status = 'abandoned' WHERE id = $1 AND status = 'pending_payment' RETURNING id`,
      [purchase.subscription_id]
    ),
    'subscription pending_payment -> abandoned'
  );
  expectOneRow(
    await client.query(
      `UPDATE subscription_purchases SET status = 'void' WHERE id = $1 AND status = 'open' RETURNING id`,
      [purchase.id]
    ),
    'purchase open -> void'
  );

  return {
    purchase_id: purchase.id,
    reason,
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    subscription_id: purchase.subscription_id,
    company_id: purchase.company_id,
    cancelled_payment_attempt_ids: cancelled,
  };
}

// ---------------------------------------------------------------------------
// Manual Platform Admin paths (design v3 §9.7 / R2). Caller already holds
// companies FOR UPDATE. Unexpired open purchase -> blocked (409). Expired open
// purchase -> voided in the caller's transaction, then the caller continues.
//
// SIMULATOR-STAGE RULE ONLY (release-owner clarification #2): voiding purely
// because the local clock passed expires_at is safe today only because the
// B6 simulator is the provider and cannot authorize success after expiry. A
// real provider may authorize before expiry and deliver its verified callback
// afterwards; before any real provider is added this rule MUST be redesigned
// or reconciled with provider state.
// ---------------------------------------------------------------------------
export type AdminOpenPurchaseOutcome =
  | { kind: 'none' }
  | { kind: 'blocked'; purchaseId: string; expiresAt: string | null }
  | { kind: 'voided'; snapshot: VoidSnapshot };

export async function handleOpenPurchaseForAdminAction(client: Queryable, companyId: string): Promise<AdminOpenPurchaseOutcome> {
  const open = await lockOpenPurchase(client, companyId);
  if (!open) return { kind: 'none' };
  if (open.unexpired) return { kind: 'blocked', purchaseId: open.id, expiresAt: open.expires_at };
  const snapshot = await voidPurchaseChain(client, open.id, 'expired_admin_action');
  return { kind: 'voided', snapshot };
}

// ---------------------------------------------------------------------------
// Confirm (design v3 §9.2) — POST /api/billing/purchases.
// ---------------------------------------------------------------------------
export interface ConfirmPurchaseInput {
  companyId: string;
  plan: StandardPlan;
  interval: BillingInterval;
  currency: string;
  amountText: string;
}

export type ConfirmPurchaseResult =
  | { kind: 'replayed'; purchaseId: string }
  | { kind: 'created'; purchaseId: string; invoiceId: string; invoiceNumber: string; subscriptionId: string; voided: VoidSnapshot | null };

async function assertTrialEligibleLocked(client: Queryable, companyId: string): Promise<{ plan: string; subscription_status: string }> {
  const company = (
    await client.query(`SELECT id, plan, subscription_status FROM companies WHERE id = $1 FOR UPDATE`, [companyId])
  ).rows[0];
  if (!company) throw new PurchaseError(404, 'NOT_FOUND', 'Company not found');
  // Fresh statement after the lock (READ COMMITTED lesson from B2).
  const live = await client.query(
    `SELECT EXISTS (SELECT 1 FROM subscriptions WHERE company_id = $1 AND status IN ('active','past_due')) AS has_live`,
    [companyId]
  );
  if (company.subscription_status !== 'trial' || live.rows[0]?.has_live === true) {
    throw new PurchaseError(409, 'NOT_ELIGIBLE', 'Self-service checkout is available only for trial accounts without an active subscription.');
  }
  return company;
}

export async function confirmPurchase(pool: Connectable, input: ConfirmPurchaseInput): Promise<ConfirmPurchaseResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertTrialEligibleLocked(client, input.companyId);

    let voided: VoidSnapshot | null = null;
    const open = await lockOpenPurchase(client, input.companyId);
    if (open) {
      if (open.unexpired && open.target_plan === input.plan && open.target_interval === input.interval) {
        await client.query('COMMIT');
        return { kind: 'replayed', purchaseId: open.id };
      }
      voided = await voidPurchaseChain(client, open.id, open.unexpired ? 'superseded' : 'expired_superseded');
    }

    // confirmed_at is captured ONCE, here, after every lock and check above
    // (a volatile CTE is evaluated exactly once) and stored as
    // current_period_start. Everything else derives from that stored value.
    const sub = expectOneRow(
      await client.query(
        `WITH c AS (SELECT clock_timestamp() AS confirmed_at)
         INSERT INTO subscriptions
           (company_id, plan, status, currency, period_amount, monthly_price, billing_interval,
            current_period_start, current_period_end, auto_renew, next_billing_date)
         SELECT $1::uuid, $2::text, 'pending_payment', $3::text, $4::numeric,
                CASE WHEN $5::text = 'annual' THEN round($4::numeric / 12, 3) ELSE $4::numeric END,
                $5::text,
                c.confirmed_at,
                ((c.confirmed_at AT TIME ZONE 'UTC')
                   + CASE WHEN $5::text = 'annual' THEN interval '12 months' ELSE interval '1 month' END) AT TIME ZONE 'UTC',
                false,
                ((c.confirmed_at AT TIME ZONE 'UTC')
                   + CASE WHEN $5::text = 'annual' THEN interval '12 months' ELSE interval '1 month' END)
         FROM c
         RETURNING id`,
        [input.companyId, input.plan, input.currency, input.amountText, input.interval]
      ),
      'pending subscription insert'
    );

    const invoice = expectOneRow(
      await client.query(
        `INSERT INTO invoices
           (company_id, subscription_id, plan, billing_interval, currency, amount,
            period_start, period_end, status, issue_date, due_date)
         SELECT company_id, id, plan, billing_interval, currency, period_amount,
                current_period_start, current_period_end, 'issued', current_period_start, current_period_start
         FROM subscriptions WHERE id = $1
         RETURNING id, invoice_number`,
        [sub.id]
      ),
      'invoice insert'
    );

    const purchase = expectOneRow(
      await client.query(
        `INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, created_at, expires_at)
         SELECT s.company_id, s.id, $2::uuid, s.current_period_start,
                s.current_period_start + make_interval(mins => $3::int)
         FROM subscriptions s WHERE s.id = $1
         RETURNING id`,
        [sub.id, invoice.id, CHECKOUT_WINDOW_MINUTES]
      ),
      'purchase insert'
    );

    await client.query('COMMIT');
    return {
      kind: 'created',
      purchaseId: purchase.id,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      subscriptionId: sub.id,
      voided,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'subscription_purchases_one_open_per_company') {
      // Backstop only — the company lock already serializes confirms. One
      // re-read on the plain pool, never the rolled-back client.
      const existing = (
        await pool.query(
          `SELECT sp.id, s.plan, s.billing_interval, (clock_timestamp() < sp.expires_at) AS unexpired
           FROM subscription_purchases sp JOIN subscriptions s ON s.id = sp.subscription_id
           WHERE sp.company_id = $1 AND sp.status = 'open'`,
          [input.companyId]
        )
      ).rows[0];
      if (existing && existing.unexpired && existing.plan === input.plan && existing.billing_interval === input.interval) {
        return { kind: 'replayed', purchaseId: existing.id };
      }
      throw new PurchaseError(409, 'PURCHASE_CONFLICT', 'Another checkout for this company is in progress. Refresh and try again.');
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Checkout (design v3 §9.3) — POST /api/billing/purchases/:id/checkout.
// ---------------------------------------------------------------------------
export interface StartCheckoutResult {
  purchaseId: string;
  companyId: string;
  invoiceId: string;
  attemptId: string;
  sessionId: string;
  attemptCreated: boolean;
  sessionCreated: boolean;
}

export async function startCheckout(pool: Connectable, companyId: string, purchaseId: string): Promise<StartCheckoutResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const company = (await client.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [companyId])).rows[0];
    if (!company) throw new PurchaseError(404, 'NOT_FOUND', 'Purchase not found');

    const purchase = (
      await client.query(
        `SELECT id, company_id, subscription_id, invoice_id, status
         FROM subscription_purchases WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [purchaseId, companyId]
      )
    ).rows[0];
    if (!purchase) throw new PurchaseError(404, 'NOT_FOUND', 'Purchase not found');
    if (purchase.status !== 'open') {
      throw new PurchaseError(409, 'PURCHASE_CLOSED', 'This order is no longer open.', { purchase_status: purchase.status });
    }

    const sub = expectOneRow(
      await client.query(`SELECT id, status FROM subscriptions WHERE id = $1 FOR UPDATE`, [purchase.subscription_id]),
      'pending subscription lock'
    );
    const invoice = expectOneRow(
      await client.query(`SELECT id, status FROM invoices WHERE id = $1 FOR UPDATE`, [purchase.invoice_id]),
      'invoice lock'
    );
    if (sub.status !== 'pending_payment' || invoice.status !== 'issued') {
      throw new PurchaseError(409, 'PURCHASE_CLOSED', 'This order is no longer open.');
    }
    const attempts = (
      await client.query(
        `SELECT id, status FROM payment_attempts WHERE invoice_id = $1 ORDER BY created_at, id FOR UPDATE`,
        [invoice.id]
      )
    ).rows;
    if (attempts.some((a: { status: string }) => a.status === 'succeeded')) {
      throw new PurchaseError(409, 'PURCHASE_CLOSED', 'This order has already been paid.');
    }
    const active = attempts.find((a: { status: string }) => a.status === 'initiated');
    let session: { id: string; status: string } | undefined;
    if (active) {
      session = (
        await client.query(
          `SELECT id, status FROM payment_checkout_sessions WHERE payment_attempt_id = $1 FOR UPDATE`,
          [active.id]
        )
      ).rows[0];
    }

    // Expiry decision AFTER every lock this operation needs is held, on the
    // real clock. A request that began before the deadline but waited on a
    // lock past it is rejected here.
    const clock = await client.query(
      `SELECT clock_timestamp() < expires_at AS unexpired FROM subscription_purchases WHERE id = $1`,
      [purchase.id]
    );
    if (clock.rows[0]?.unexpired !== true) {
      throw new PurchaseError(409, 'PURCHASE_EXPIRED', 'The payment window for this order has ended. Start a new order.');
    }

    let attemptId: string;
    let attemptCreated = false;
    let sessionCreated = false;
    let sessionId: string;
    if (active) {
      attemptId = active.id;
      if (session) {
        if (session.status !== 'pending') {
          throw new Error(`startCheckout: initiated attempt ${active.id} has a '${session.status}' session`);
        }
        sessionId = session.id;
      } else {
        sessionId = expectOneRow(
          await client.query(
            `INSERT INTO payment_checkout_sessions (payment_attempt_id, status) VALUES ($1, 'pending') RETURNING id`,
            [active.id]
          ),
          'session insert'
        ).id;
        sessionCreated = true;
      }
    } else {
      // Server-derived idempotency key: deterministic under the invoice lock,
      // backed by the global UNIQUE key and the one-active-per-invoice index.
      const key = `b7:${purchase.id}:${attempts.length + 1}`;
      attemptId = expectOneRow(
        await client.query(
          `INSERT INTO payment_attempts
             (invoice_id, company_id, subscription_id, amount, currency, plan,
              billing_interval, period_start, period_end, idempotency_key, status)
           SELECT id, company_id, subscription_id, amount, currency, plan,
                  billing_interval, period_start, period_end, $2, 'initiated'
           FROM invoices WHERE id = $1
           RETURNING id`,
          [invoice.id, key]
        ),
        'attempt insert'
      ).id;
      attemptCreated = true;
      sessionId = expectOneRow(
        await client.query(
          `INSERT INTO payment_checkout_sessions (payment_attempt_id, status) VALUES ($1, 'pending') RETURNING id`,
          [attemptId]
        ),
        'session insert'
      ).id;
      sessionCreated = true;
    }

    await client.query('COMMIT');
    return { purchaseId: purchase.id, companyId, invoiceId: invoice.id, attemptId, sessionId, attemptCreated, sessionCreated };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Read model for GET /api/billing/purchases/:id and the plans endpoint.
// ---------------------------------------------------------------------------
export interface PurchaseSummary {
  id: string;
  status: string;
  checkout_open: boolean;
  created_at: string | null;
  expires_at: string | null;
  plan: string;
  billing_interval: string;
  currency: string;
  amount: string;
  period_start: string | null;
  period_end: string | null;
  invoice_id: string;
  invoice_number: string;
  invoice_status: string;
  latest_attempt_status: string | null;
  latest_session_status: string | null;
}

const SUMMARY_SQL = `
  SELECT sp.id, sp.status, sp.created_at, sp.expires_at,
         (sp.status = 'open' AND clock_timestamp() < sp.expires_at) AS checkout_open,
         s.plan, s.billing_interval, s.currency,
         CASE WHEN s.currency = 'KWD' THEN s.period_amount::text ELSE round(s.period_amount, 2)::text END AS amount,
         s.current_period_start, s.current_period_end,
         i.id AS invoice_id, i.invoice_number, i.status AS invoice_status,
         la.status AS latest_attempt_status, pcs.status AS latest_session_status
  FROM subscription_purchases sp
  JOIN subscriptions s ON s.id = sp.subscription_id
  JOIN invoices i ON i.id = sp.invoice_id
  LEFT JOIN LATERAL (
    SELECT pa.id, pa.status FROM payment_attempts pa
    WHERE pa.invoice_id = sp.invoice_id
    ORDER BY pa.created_at DESC, pa.id DESC
    LIMIT 1
  ) la ON true
  LEFT JOIN payment_checkout_sessions pcs ON pcs.payment_attempt_id = la.id`;

function shapeSummary(row: any): PurchaseSummary {
  return {
    id: row.id,
    status: row.status,
    checkout_open: row.checkout_open === true,
    created_at: toIsoOrNull(row.created_at),
    expires_at: toIsoOrNull(row.expires_at),
    plan: row.plan,
    billing_interval: row.billing_interval,
    currency: row.currency,
    amount: row.amount,
    period_start: toIsoOrNull(row.current_period_start),
    period_end: toIsoOrNull(row.current_period_end),
    invoice_id: row.invoice_id,
    invoice_number: row.invoice_number,
    invoice_status: row.invoice_status,
    latest_attempt_status: row.latest_attempt_status ?? null,
    latest_session_status: row.latest_session_status ?? null,
  };
}

export async function getPurchaseSummary(db: Queryable, companyId: string, purchaseId: string): Promise<PurchaseSummary | null> {
  const result = await db.query(`${SUMMARY_SQL} WHERE sp.id = $1 AND sp.company_id = $2`, [purchaseId, companyId]);
  return result.rows[0] ? shapeSummary(result.rows[0]) : null;
}

export async function getOpenPurchaseSummary(db: Queryable, companyId: string): Promise<PurchaseSummary | null> {
  const result = await db.query(`${SUMMARY_SQL} WHERE sp.company_id = $1 AND sp.status = 'open'`, [companyId]);
  return result.rows[0] ? shapeSummary(result.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Apply on trusted success (design v3 §9.5). Called ONLY from
// resolveCheckoutSessionCore, inside its open transaction, with every §9.1
// lock already held. Takes NO clock input and performs NO expiry check: a
// trusted success is always applied if the chain is still open. (The
// simulator's own authorization gate — which is where the deadline lives —
// runs before this is ever called; see paymentSettlement.ts.)
// ---------------------------------------------------------------------------
export interface LockedPurchaseChain {
  company: { id: string; plan: string; subscription_status: string };
  purchase: { id: string; status: string; subscription_id: string; invoice_id: string };
  pendingSub: { id: string; status: string; plan: string };
  attempt: { id: string };
  session: { id: string };
  invoice: { id: string };
}

export interface AppliedPurchase {
  purchase_id: string;
  company_id: string;
  subscription_id: string;
  old_values: { plan: string; subscription_status: string };
  new_values: { plan: string; subscription_status: 'active' };
  billing_interval: string;
  current_period_start: string | null;
  current_period_end: string | null;
  completed_at: string | null;
}

export async function applyPurchaseOnTrustedSuccess(
  client: Queryable,
  locked: LockedPurchaseChain
): Promise<{ settle: SettleOutcomeResult; applied: AppliedPurchase }> {
  // Integrity assertions. §9.7 makes a violation unreachable; if one ever
  // happens anyway, throw (ROLLBACK, 500, loud log) — never silently apply,
  // never silently drop.
  if (locked.purchase.status !== 'open') {
    throw new Error(`applyPurchaseOnTrustedSuccess: purchase ${locked.purchase.id} is '${locked.purchase.status}'`);
  }
  if (locked.pendingSub.status !== 'pending_payment') {
    throw new Error(`applyPurchaseOnTrustedSuccess: subscription ${locked.pendingSub.id} is '${locked.pendingSub.status}'`);
  }
  if (locked.company.subscription_status !== 'trial') {
    throw new Error(`applyPurchaseOnTrustedSuccess: company ${locked.company.id} is '${locked.company.subscription_status}', not 'trial'`);
  }
  const live = await client.query(
    `SELECT EXISTS (SELECT 1 FROM subscriptions WHERE company_id = $1 AND status IN ('active','past_due')) AS has_live`,
    [locked.company.id]
  );
  if (live.rows[0]?.has_live === true) {
    throw new Error(`applyPurchaseOnTrustedSuccess: company ${locked.company.id} already has a live subscription`);
  }

  const settle = await settleOutcome(client as PoolClient, {
    attempt: { id: locked.attempt.id },
    session: { id: locked.session.id },
    invoice: { id: locked.invoice.id },
    outcome: 'succeeded',
  });

  const activated = expectOneRow(
    await client.query(
      `UPDATE subscriptions SET status = 'active' WHERE id = $1 AND status = 'pending_payment'
       RETURNING id, plan, billing_interval, current_period_start, current_period_end`,
      [locked.pendingSub.id]
    ),
    'subscription pending_payment -> active'
  );
  await client.query(`UPDATE companies SET plan = $1, subscription_status = 'active' WHERE id = $2`, [
    activated.plan,
    locked.company.id,
  ]);
  await cancelTrialLifecycleEmails(client, locked.company.id);
  const completed = expectOneRow(
    await client.query(
      `UPDATE subscription_purchases SET status = 'completed' WHERE id = $1 AND status = 'open' RETURNING completed_at`,
      [locked.purchase.id]
    ),
    'purchase open -> completed'
  );

  return {
    settle,
    applied: {
      purchase_id: locked.purchase.id,
      company_id: locked.company.id,
      subscription_id: activated.id,
      old_values: { plan: locked.company.plan, subscription_status: locked.company.subscription_status },
      new_values: { plan: activated.plan, subscription_status: 'active' },
      billing_interval: activated.billing_interval,
      current_period_start: toIsoOrNull(activated.current_period_start),
      current_period_end: toIsoOrNull(activated.current_period_end),
      completed_at: toIsoOrNull(completed.completed_at),
    },
  };
}
