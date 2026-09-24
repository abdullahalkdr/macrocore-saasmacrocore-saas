// Stage B6 — Provider-Neutral Simulated Payment Flow (design pass v5 §4, §8).
//
// settleOutcome() is the ONLY function in this codebase that ever writes
// status='succeeded'/'failed'/'cancelled' to payment_attempts, a matching
// status to payment_checkout_sessions, or 'paid'/payment_date to invoices.
// It takes already-locked rows (locked by the caller, in the fixed
// invoice -> attempt -> session order — see admin.controller.ts) whose
// precondition checks have already passed, and performs WRITES ONLY —
// never an authorization/eligibility decision, and NEVER a logAudit() call.
// Every caller invokes this while still inside its open transaction, then
// COMMITs, releases the connection, and ONLY THEN calls one of the
// buildAuditPayloadFor*() helpers below + logAudit(), in its own try/catch —
// this is what makes "no audit call may execute inside the open financial
// transaction" mechanically true rather than merely documented (v5 §4).
//
// Money/timestamp discipline (implementation clarification #5): every
// column a trigger owns (succeeded_at/failed_at/cancelled_at,
// payment_checkout_sessions.resolved_at) or that this function itself sets
// (invoices.payment_date) is read back via UPDATE ... RETURNING, never
// re-derived in application code — so the exact PostgreSQL transaction-time
// value the database actually stamped is what ends up in the returned
// result and, from there, in the post-commit audit payload.

import { PoolClient } from 'pg';

export type SettlementOutcome = 'succeeded' | 'failed' | 'cancelled';

export interface SettleOutcomeParams {
  attempt: { id: string };
  // The already-locked payment_checkout_sessions row, or null —
  // markPaymentAttemptFailed's zero-session case.
  session: { id: string } | null;
  // The already-locked invoices row, or null — never needed/locked for an
  // outcome other than 'succeeded'.
  invoice: { id: string } | null;
  outcome: SettlementOutcome;
}

export interface SettleOutcomeResult {
  attemptId: string;
  attemptNewStatus: SettlementOutcome;
  attemptResolvedAt: string | null;
  sessionId: string | null;
  sessionExisted: boolean;
  sessionResolvedAt: string | null;
  invoiceId: string | null;
  invoiceNewStatus: 'paid' | null;
  invoicePaymentDate: string | null;
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function settleOutcome(client: PoolClient, params: SettleOutcomeParams): Promise<SettleOutcomeResult> {
  const { attempt, session, invoice, outcome } = params;

  // Exactly one UPDATE on payment_attempts, ever, per call — the guard
  // trigger (MIGRATION_084/085) stamps the matching *_at column itself;
  // RETURNING reads that trigger-owned value back rather than trusting a
  // JS-side now().
  const attemptResult = await client.query(
    `UPDATE payment_attempts SET status = $2 WHERE id = $1
     RETURNING id, status, failed_at, succeeded_at, cancelled_at`,
    [attempt.id, outcome]
  );
  const attemptRow = attemptResult.rows[0];

  const attemptResolvedAt = toIsoOrNull(attemptRow[`${outcome}_at`]);

  let sessionRow: { id: string; status: string; resolved_at: unknown } | undefined;
  if (session != null) {
    // Exactly one UPDATE on payment_checkout_sessions — the literal fix for
    // the v3-era double-UPDATE bug: there is no other UPDATE statement
    // anywhere in this codebase that touches this table's status column.
    const sessionResult = await client.query(
      `UPDATE payment_checkout_sessions SET status = $2 WHERE id = $1 RETURNING id, status, resolved_at`,
      [session.id, outcome]
    );
    sessionRow = sessionResult.rows[0];
  }

  let invoiceRow: { id: string; status: string; payment_date: unknown } | undefined;
  if (outcome === 'succeeded') {
    if (!invoice) {
      throw new Error('settleOutcome: invoice is required when outcome is "succeeded"');
    }
    const invoiceResult = await client.query(
      `UPDATE invoices SET status = 'paid', payment_date = now() WHERE id = $1
       RETURNING id, status, payment_date`,
      [invoice.id]
    );
    invoiceRow = invoiceResult.rows[0];
  }

  return {
    attemptId: attemptRow.id,
    attemptNewStatus: attemptRow.status as SettlementOutcome,
    attemptResolvedAt,
    sessionId: sessionRow?.id ?? null,
    sessionExisted: session != null,
    sessionResolvedAt: sessionRow ? toIsoOrNull(sessionRow.resolved_at) : null,
    invoiceId: invoiceRow?.id ?? null,
    invoiceNewStatus: invoiceRow ? 'paid' : null,
    invoicePaymentDate: invoiceRow ? toIsoOrNull(invoiceRow.payment_date) : null,
  };
}

// --- Post-commit audit payload builders (design v5 §8) -------------------
// Called by the caller, AFTER COMMIT + connection release, wrapped in the
// caller's own try/catch. Neither function performs any I/O — they are pure
// shape-builders over settleOutcome's already-returned data.

export type ResolvedVia = 'admin_api' | 'simulated_hosted_page';

export function buildAuditPayloadForResolve(
  result: SettleOutcomeResult,
  resolvedVia: ResolvedVia,
  purchase?: { purchaseId?: string | null; applied?: AppliedPurchase | null }
) {
  return {
    action: 'payment_checkout_session_resolved',
    entityType: 'payment_checkout_sessions',
    entityId: result.sessionId,
    oldValues: { status: 'pending' },
    newValues: {
      status: result.attemptNewStatus,
      provider: 'simulated',
      resolved_via: resolvedVia,
      ...(result.invoiceId
        ? {
            payment_attempt_status: result.attemptNewStatus,
            invoice_status: result.invoiceNewStatus,
            invoice_payment_date: result.invoicePaymentDate,
          }
        : {}),
      // Stage B7 — only for sessions whose invoice belongs to a self-service
      // purchase; absent (unchanged B6 shape) otherwise.
      ...(purchase?.purchaseId
        ? {
            purchase_id: purchase.purchaseId,
            purchase_status: purchase.applied ? 'completed' : 'open',
            ...(purchase.applied ? { applied_plan: purchase.applied.new_values.plan } : {}),
          }
        : {}),
    },
  };
}

export function buildAuditPayloadForMarkFailed(result: SettleOutcomeResult) {
  return {
    action: 'admin_payment_attempt_failed',
    entityType: 'payment_attempts',
    entityId: result.attemptId,
    oldValues: { status: 'initiated' },
    newValues: {
      status: 'failed',
      failed_at: result.attemptResolvedAt,
      ...(result.sessionExisted
        ? {
            checkout_session_id: result.sessionId,
            checkout_session_status: 'failed',
            provider: 'simulated',
          }
        : {}),
    },
  };
}

// --- Shared settlement transaction (design v5 §5.6) -----------------------
// Used by BOTH the admin-key-gated programmatic resolve route
// (admin.controller.ts::resolveCheckoutSession, resolvedVia='admin_api')
// and the hosted checkout page's resolve endpoint
// (simulatedCheckout.controller.ts, resolvedVia='simulated_hosted_page') —
// proving the shared core works with two real callers, not just describing
// it abstractly. This function performs ONLY the fixed invoice -> attempt
// -> session lock order, the three named preconditions, and the write via
// settleOutcome — it does NOT check PAYMENT_SIMULATOR_OPERATIONAL or the
// per-company allowlist itself (each caller's own route re-checks those
// live, per correction #5, using whatever caller-specific 403/404 mapping
// its own trust model calls for — the admin route returns 403, the hosted
// page returns 404 to avoid distinguishing "not found" from "not allowed"
// to an unauthenticated-feeling caller). It also never calls logAudit —
// that happens in each caller, after COMMIT, in its own try/catch, per §4.

import { Pool } from 'pg';
import { applyPurchaseOnTrustedSuccess, AppliedPurchase } from './subscriptionPurchase';

export type ResolveCoreResult =
  | { kind: 'not_found' }
  | { kind: 'conflict'; message: string; code?: string }
  | {
      kind: 'ok';
      result: SettleOutcomeResult;
      session: { id: string; status: SettlementOutcome; resolved_at: string | null };
      // Stage B7 — present only when the settled invoice belongs to a
      // self-service subscription purchase AND the outcome applied it.
      purchaseApplied?: AppliedPurchase;
      purchaseId?: string | null;
    };

export async function resolveCheckoutSessionCore(
  pool: Pool,
  sessionId: string,
  outcome: SettlementOutcome
): Promise<ResolveCoreResult> {
  // UNLOCKED pre-transaction lookup — routing IDs only (attempt_id,
  // invoice_id), one query, both hops (session -> attempt -> invoice).
  // Nothing here is trusted for any STATUS or business-logic decision.
  // Stage B7: also returns the self-service purchase linked to the invoice,
  // if any. That link is immutable and created atomically WITH the invoice
  // (subscription_purchases guard trigger), so an unlocked read is
  // trustworthy for choosing which code path runs.
  const routing = await pool.query(
    `SELECT pa.id AS attempt_id, pa.invoice_id AS invoice_id,
            sp.id AS purchase_id, sp.company_id AS purchase_company_id
     FROM payment_checkout_sessions pcs
     JOIN payment_attempts pa ON pa.id = pcs.payment_attempt_id
     LEFT JOIN subscription_purchases sp ON sp.invoice_id = pa.invoice_id
     WHERE pcs.id = $1`,
    [sessionId]
  );
  const routingRow = routing.rows[0];
  if (!routingRow) return { kind: 'not_found' };

  if (routingRow.purchase_id) {
    return resolvePurchaseLinkedSession(pool, sessionId, outcome, routingRow);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. INVOICE FIRST, always.
    const invoiceResult = await client.query(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [routingRow.invoice_id]);
    const invoiceRow = invoiceResult.rows[0];
    if (!invoiceRow) {
      await client.query('ROLLBACK');
      return { kind: 'not_found' };
    }

    // 2. ATTEMPT SECOND, locked fresh under the invoice lock.
    const attemptResult = await client.query(`SELECT * FROM payment_attempts WHERE id = $1 FOR UPDATE`, [routingRow.attempt_id]);
    const attemptRow = attemptResult.rows[0];
    if (!attemptRow || attemptRow.invoice_id !== invoiceRow.id) {
      await client.query('ROLLBACK');
      return { kind: 'not_found' };
    }

    // 3. SESSION THIRD, re-derived by attempt_id, not by the original
    // sessionId directly.
    const sessionResult = await client.query(
      `SELECT * FROM payment_checkout_sessions WHERE payment_attempt_id = $1 FOR UPDATE`,
      [attemptRow.id]
    );
    const sessionRow = sessionResult.rows[0];
    if (!sessionRow || sessionRow.id !== sessionId) {
      await client.query('ROLLBACK');
      return { kind: 'not_found' };
    }

    // Preconditions — checked only now, all three locks held.
    if (sessionRow.status !== 'pending') {
      await client.query('ROLLBACK');
      return { kind: 'conflict', message: `checkout session is already resolved as '${sessionRow.status}'` };
    }
    if (attemptRow.status !== 'initiated') {
      await client.query('ROLLBACK');
      return { kind: 'conflict', message: 'payment attempt is not in an initiated state' };
    }
    if (invoiceRow.status !== 'issued') {
      await client.query('ROLLBACK');
      return { kind: 'conflict', message: 'invoice is not in an issued state' };
    }

    const result = await settleOutcome(client, {
      attempt: { id: attemptRow.id },
      session: { id: sessionRow.id },
      invoice: outcome === 'succeeded' ? { id: invoiceRow.id } : null,
      outcome,
    });

    await client.query('COMMIT');
    return {
      kind: 'ok',
      result,
      session: {
        id: result.sessionId as string,
        status: result.attemptNewStatus,
        resolved_at: result.sessionResolvedAt,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Stage B7 — settlement of a session whose invoice belongs to a self-service
// subscription purchase (design v3 §9.1, §9.4, §9.5). Same shared core, both
// simulator callers (hosted page + admin resolve route). Lock order is the
// B7 global order: companies -> subscription_purchases -> subscriptions ->
// invoices -> payment_attempts -> payment_checkout_sessions.
// ---------------------------------------------------------------------------
async function resolvePurchaseLinkedSession(
  pool: Pool,
  sessionId: string,
  outcome: SettlementOutcome,
  routingRow: { attempt_id: string; invoice_id: string; purchase_id: string; purchase_company_id: string }
): Promise<ResolveCoreResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const companyRow = (
      await client.query(`SELECT id, plan, subscription_status FROM companies WHERE id = $1 FOR UPDATE`, [
        routingRow.purchase_company_id,
      ])
    ).rows[0];
    const purchaseRow = (
      await client.query(
        `SELECT id, company_id, subscription_id, invoice_id, status FROM subscription_purchases WHERE id = $1 FOR UPDATE`,
        [routingRow.purchase_id]
      )
    ).rows[0];
    if (!companyRow || !purchaseRow || purchaseRow.invoice_id !== routingRow.invoice_id || purchaseRow.company_id !== companyRow.id) {
      await client.query('ROLLBACK');
      return { kind: 'not_found' };
    }
    const pendingSubRow = (
      await client.query(`SELECT id, status, plan FROM subscriptions WHERE id = $1 FOR UPDATE`, [purchaseRow.subscription_id])
    ).rows[0];
    const invoiceRow = (await client.query(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [routingRow.invoice_id])).rows[0];
    if (!pendingSubRow || !invoiceRow) {
      await client.query('ROLLBACK');
      return { kind: 'not_found' };
    }
    const attemptRow = (await client.query(`SELECT * FROM payment_attempts WHERE id = $1 FOR UPDATE`, [routingRow.attempt_id])).rows[0];
    if (!attemptRow || attemptRow.invoice_id !== invoiceRow.id) {
      await client.query('ROLLBACK');
      return { kind: 'not_found' };
    }
    const sessionRow = (
      await client.query(`SELECT * FROM payment_checkout_sessions WHERE payment_attempt_id = $1 FOR UPDATE`, [attemptRow.id])
    ).rows[0];
    if (!sessionRow || sessionRow.id !== sessionId) {
      await client.query('ROLLBACK');
      return { kind: 'not_found' };
    }

    // Existing B6 preconditions, unchanged, all locks held.
    if (sessionRow.status !== 'pending') {
      await client.query('ROLLBACK');
      return { kind: 'conflict', message: `checkout session is already resolved as '${sessionRow.status}'` };
    }
    if (attemptRow.status !== 'initiated') {
      await client.query('ROLLBACK');
      return { kind: 'conflict', message: 'payment attempt is not in an initiated state' };
    }
    if (invoiceRow.status !== 'issued') {
      await client.query('ROLLBACK');
      return { kind: 'conflict', message: 'invoice is not in an issued state' };
    }

    if (outcome !== 'succeeded') {
      // failed/cancelled: no deadline check, no purchase/subscription/company
      // write. The purchase stays open (retryable until its window ends).
      const result = await settleOutcome(client, {
        attempt: { id: attemptRow.id },
        session: { id: sessionRow.id },
        invoice: null,
        outcome,
      });
      await client.query('COMMIT');
      return {
        kind: 'ok',
        result,
        session: { id: result.sessionId as string, status: result.attemptNewStatus, resolved_at: result.sessionResolvedAt },
        purchaseId: purchaseRow.id,
      };
    }

    // Simulated-provider authorization gate (design v3 §9.4, R1). In B7 the
    // simulator IS the provider, and this is its authorization decision: a
    // fresh clock_timestamp() comparison issued only after every lock above
    // is held — never transaction now(). Refusal writes nothing.
    const gate = await client.query(
      `SELECT (status = 'open' AND clock_timestamp() < expires_at) AS may_succeed FROM subscription_purchases WHERE id = $1`,
      [purchaseRow.id]
    );
    if (gate.rows[0]?.may_succeed !== true) {
      await client.query('ROLLBACK');
      return {
        kind: 'conflict',
        code: 'SESSION_EXPIRED',
        message: 'the payment window for this order has ended; this checkout can no longer succeed',
      };
    }

    const { settle, applied } = await applyPurchaseOnTrustedSuccess(client, {
      company: companyRow,
      purchase: purchaseRow,
      pendingSub: pendingSubRow,
      attempt: { id: attemptRow.id },
      session: { id: sessionRow.id },
      invoice: { id: invoiceRow.id },
    });

    await client.query('COMMIT');
    return {
      kind: 'ok',
      result: settle,
      session: { id: settle.sessionId as string, status: settle.attemptNewStatus, resolved_at: settle.sessionResolvedAt },
      purchaseApplied: applied,
      purchaseId: purchaseRow.id,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Stage B7 — post-commit audit payload for a self-service purchase applied by
// a trusted simulated success. Pure shape-builder; the caller logs it after
// COMMIT, in its own try/catch, next to buildAuditPayloadForResolve's row.
export function buildAuditPayloadForPurchaseApplied(applied: AppliedPurchase) {
  return {
    action: 'subscription_purchase_applied',
    entityType: 'subscription_purchases',
    entityId: applied.purchase_id,
    oldValues: applied.old_values,
    newValues: {
      ...applied.new_values,
      subscription_id: applied.subscription_id,
      billing_interval: applied.billing_interval,
      current_period_start: applied.current_period_start,
      current_period_end: applied.current_period_end,
      completed_at: applied.completed_at,
    },
  };
}
