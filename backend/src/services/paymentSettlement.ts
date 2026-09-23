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

export function buildAuditPayloadForResolve(result: SettleOutcomeResult, resolvedVia: ResolvedVia) {
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

export type ResolveCoreResult =
  | { kind: 'not_found' }
  | { kind: 'conflict'; message: string }
  | {
      kind: 'ok';
      result: SettleOutcomeResult;
      session: { id: string; status: SettlementOutcome; resolved_at: string | null };
    };

export async function resolveCheckoutSessionCore(
  pool: Pool,
  sessionId: string,
  outcome: SettlementOutcome
): Promise<ResolveCoreResult> {
  // UNLOCKED pre-transaction lookup — routing IDs only (attempt_id,
  // invoice_id), one query, both hops (session -> attempt -> invoice).
  // Nothing here is trusted for any STATUS or business-logic decision.
  const routing = await pool.query(
    `SELECT pa.id AS attempt_id, pa.invoice_id AS invoice_id
     FROM payment_checkout_sessions pcs
     JOIN payment_attempts pa ON pa.id = pcs.payment_attempt_id
     WHERE pcs.id = $1`,
    [sessionId]
  );
  const routingRow = routing.rows[0];
  if (!routingRow) return { kind: 'not_found' };

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
