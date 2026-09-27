// Stage B8.2 — Production-safe expired self-service purchase cleanup.
// Binding design: claude/chat8c-b8-2-expired-purchase-cleanup-design-pass-v3-2026-09-27.md
// (approved; §4, §5, §6, §8, §11).
//
// A periodic, bounded, kill-switched sweep that voids genuinely expired,
// unresolved B7 (trial -> paid) and B8 (upgrade) purchases. One transaction
// per purchase, sequential, following the global lock order:
//
//   companies (FOR UPDATE SKIP LOCKED) -> subscription_purchases
//     -> subscriptions (source, then pending) -> invoices
//     -> payment_attempts (created_at, id) -> payment_checkout_sessions (every attempt)
//
// The expiry decision is a fresh `clock_timestamp() >= expires_at` statement
// issued AFTER the last lock (design v3 §6 T2) — the exact complement of the
// settlement gate. clock_timestamp() is wall-clock time, not monotonic (T4):
// safety comes from the post-lock read plus the terminal-state triggers.
//
// Every write goes through subscriptionPurchase.ts's applyPurchaseVoid(), the
// same writes as every other void. Nothing here inserts or touches email_jobs.
//
// Budgets per tick (design v3 §5.1): at most COMMIT_BUDGET successful
// committed voids and at most SCAN_BUDGET candidates processed — SCAN_BUDGET
// is the hard upper bound on candidates processed in one tick, including every
// failed item-processing attempt. The resume cursor is in-process only.
//
// Logs carry UUIDs, counters, a classification and a validated SQLSTATE only —
// never a raw error message, email, name, amount, token or session id.

import { env } from '../config/env';
import { pool as defaultPool } from '../db/pool';
import { logAudit } from '../utils/audit';
import {
  applyPurchaseVoid,
  Connectable,
  lockAndValidatePurchaseChain,
  PurchaseChainAnomaly,
  Queryable,
  VoidSnapshot,
} from './subscriptionPurchase';

export const EXPIRED_CLEANUP_COMMIT_BUDGET = 25;
export const EXPIRED_CLEANUP_PAGE_SIZE = 25;
export const EXPIRED_CLEANUP_SCAN_BUDGET = 100;
export const EXPIRED_CLEANUP_LOCK_TIMEOUT = '5s';

export interface ExpiredPurchaseCandidate {
  id: string;
  company_id: string;
}

export type CleanupItemOutcome =
  | 'voided'
  | 'skipped_busy'
  | 'skipped_missing'
  | 'skipped_resolved'
  | 'skipped_not_expired'
  | 'skipped_lock_timeout'
  | 'anomaly_pending'
  | 'anomaly_invoice'
  | 'anomaly_attempt'
  | 'anomaly_session'
  | 'anomaly_source'
  | 'provider_guard'
  | 'error';

export type CleanupErrorClass = 'lock' | 'void' | 'commit' | 'unknown';

export interface CleanupItemResult {
  outcome: CleanupItemOutcome;
  // Present only for outcome 'voided': whether the post-commit audit row was written.
  auditOk?: boolean;
  snapshot?: VoidSnapshot;
  // Present only for outcome 'error'.
  errorClass?: CleanupErrorClass;
  pgCode?: string;
}

function safePgCode(err: unknown): string | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

// ---------------------------------------------------------------------------
// Per-purchase transaction (design v3 §5.2). Never throws for a data or
// database condition: every path ends in COMMIT or ROLLBACK and returns a
// classified result.
// ---------------------------------------------------------------------------
export async function cleanupOneExpiredPurchase(db: Connectable, candidate: ExpiredPurchaseCandidate): Promise<CleanupItemResult> {
  const client = await db.connect();
  let phase: CleanupErrorClass = 'lock';
  let snapshot: VoidSnapshot | null = null;
  let replacesSubscriptionId: string | null = null;
  const rollback = async (result: CleanupItemResult): Promise<CleanupItemResult> => {
    await client.query('ROLLBACK').catch(() => {});
    return result;
  };
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${EXPIRED_CLEANUP_LOCK_TIMEOUT}'`);

    // 1. companies — SKIP LOCKED: never queue behind user/admin/other-replica work.
    const company = (await client.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE SKIP LOCKED`, [candidate.company_id])).rows[0];
    if (!company) return await rollback({ outcome: 'skipped_busy' });

    // 2. subscription_purchases — scoped to the candidate's own company.
    const purchase = (
      await client.query(
        `SELECT id, company_id, subscription_id, invoice_id, status, replaces_subscription_id
         FROM subscription_purchases WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [candidate.id, candidate.company_id]
      )
    ).rows[0];
    if (!purchase) return await rollback({ outcome: 'skipped_missing' });
    if (purchase.status !== 'open') return await rollback({ outcome: 'skipped_resolved' });

    // 3. Source subscription (upgrade only) — locked, validated (E7), never written.
    replacesSubscriptionId = purchase.replaces_subscription_id ?? null;
    if (replacesSubscriptionId) {
      const source = (
        await client.query(`SELECT id, company_id, status FROM subscriptions WHERE id = $1 AND company_id = $2 FOR UPDATE`, [
          replacesSubscriptionId,
          candidate.company_id,
        ])
      ).rows[0];
      if (!source || source.status !== 'active') return await rollback({ outcome: 'anomaly_source' });
    }

    // 4-8. pending -> invoice -> every attempt -> every session, then validation.
    let chain;
    try {
      chain = await lockAndValidatePurchaseChain(client, purchase);
    } catch (err) {
      if (err instanceof PurchaseChainAnomaly) return await rollback({ outcome: err.anomalyClass });
      throw err;
    }

    // 9. AUTHORITATIVE expiry decision — after the last lock, database clock only.
    const decision = (
      await client.query(
        `SELECT (status = 'open' AND clock_timestamp() >= expires_at) AS expired_unresolved FROM subscription_purchases WHERE id = $1`,
        [purchase.id]
      )
    ).rows[0];
    if (decision?.expired_unresolved !== true) return await rollback({ outcome: 'skipped_not_expired' });

    // 10. Writes only (no new locks).
    phase = 'void';
    snapshot = await applyPurchaseVoid(client, chain, 'expired_cleanup');
    phase = 'commit';
    await client.query('COMMIT');
  } catch (err) {
    const pgCode = safePgCode(err);
    await client.query('ROLLBACK').catch(() => {});
    if (pgCode === '55P03') return { outcome: 'skipped_lock_timeout' };
    return { outcome: 'error', errorClass: phase, ...(pgCode ? { pgCode } : {}) };
  } finally {
    client.release();
  }

  if (!snapshot) return { outcome: 'error', errorClass: 'unknown' }; // unreachable: every other path returned above

  // Post-commit audit (design v3 §11.2): at most one row per void; normally
  // exactly one, zero if this insert fails or the process dies first.
  let auditOk = false;
  try {
    auditOk = await logAudit({
      companyId: snapshot.company_id,
      userId: null,
      action: 'subscription_purchase_voided',
      entityType: 'subscription_purchases',
      entityId: snapshot.purchase_id,
      oldValues: { status: 'open' },
      newValues: {
        status: 'void',
        reason: snapshot.reason,
        actor: 'system_expired_purchase_cleanup',
        invoice_id: snapshot.invoice_id,
        invoice_number: snapshot.invoice_number,
        subscription_id: snapshot.subscription_id,
        ...(replacesSubscriptionId ? { replaces_subscription_id: replacesSubscriptionId } : {}),
        cancelled_payment_attempt_ids: snapshot.cancelled_payment_attempt_ids,
      },
    });
  } catch {
    auditOk = false; // logAudit never throws; defensive only.
  }
  return { outcome: 'voided', auditOk, snapshot };
}

// ---------------------------------------------------------------------------
// Candidate paging (design v3 §5.1) — unlocked, routing only. The cursor is a
// purchase id; (expires_at, id) of that row is immutable, so no timestamp ever
// passes through JavaScript.
// ---------------------------------------------------------------------------
export async function selectExpiredCandidates(db: Queryable, pageSize: number, afterId: string | null): Promise<ExpiredPurchaseCandidate[]> {
  const result = await db.query(
    `SELECT sp.id, sp.company_id
     FROM subscription_purchases sp
     WHERE sp.status = 'open'
       AND sp.expires_at <= clock_timestamp()
       AND ($2::uuid IS NULL
            OR (sp.expires_at, sp.id) > (SELECT c.expires_at, c.id FROM subscription_purchases c WHERE c.id = $2::uuid))
     ORDER BY sp.expires_at ASC, sp.id ASC
     LIMIT $1`,
    [pageSize, afterId]
  );
  return result.rows.map((r: { id: string; company_id: string }) => ({ id: r.id, company_id: r.company_id }));
}

// ---------------------------------------------------------------------------
// The sweep (design v3 §8.1).
// ---------------------------------------------------------------------------
export interface ExpiredPurchaseSweepSummary {
  enabled: boolean;
  overlap: boolean;
  processed: number;
  pages: number;
  voided: number;
  skipped_busy: number;
  skipped_missing: number;
  skipped_resolved: number;
  skipped_not_expired: number;
  skipped_lock_timeout: number;
  anomalies: number;
  provider_guard: number;
  errors: number;
  audit_errors: number;
  cursor_wrapped: boolean;
  duration_ms: number;
}

export interface ExpiredPurchaseSweepOptions {
  commitBudget?: number;
  pageSize?: number;
  scanBudget?: number;
  db?: Connectable;
}

let running = false;
let resumeCursor: string | null = null;

// Test-only helpers (in-process state has no other observer).
export function resetExpiredPurchaseCleanupState(): void {
  running = false;
  resumeCursor = null;
}
export function getExpiredPurchaseCleanupCursor(): string | null {
  return resumeCursor;
}

function emptySummary(enabled: boolean, overlap: boolean): ExpiredPurchaseSweepSummary {
  return {
    enabled,
    overlap,
    processed: 0,
    pages: 0,
    voided: 0,
    skipped_busy: 0,
    skipped_missing: 0,
    skipped_resolved: 0,
    skipped_not_expired: 0,
    skipped_lock_timeout: 0,
    anomalies: 0,
    provider_guard: 0,
    errors: 0,
    audit_errors: 0,
    cursor_wrapped: false,
    duration_ms: 0,
  };
}

export async function sweepExpiredPurchases(options: ExpiredPurchaseSweepOptions = {}): Promise<ExpiredPurchaseSweepSummary> {
  // Self-guard FIRST, before any DB access (same convention as every sweep).
  if (!env.ENABLE_BACKGROUND_SWEEPS || !env.ENABLE_EXPIRED_PURCHASE_CLEANUP) return emptySummary(false, false);
  if (running) return emptySummary(true, true);
  running = true;

  const commitBudget = options.commitBudget ?? EXPIRED_CLEANUP_COMMIT_BUDGET;
  const pageSize = options.pageSize ?? EXPIRED_CLEANUP_PAGE_SIZE;
  const scanBudget = options.scanBudget ?? EXPIRED_CLEANUP_SCAN_BUDGET;
  const db: Connectable = options.db ?? (defaultPool as unknown as Connectable);
  const summary = emptySummary(true, false);
  const started = Date.now();
  let committed = 0;

  try {
    while (summary.processed < scanBudget && committed < commitBudget) {
      let page: ExpiredPurchaseCandidate[];
      try {
        page = await selectExpiredCandidates(db, pageSize, resumeCursor);
      } catch (err) {
        const pgCode = safePgCode(err);
        summary.errors += 1;
        console.error('[expiredPurchaseCleanup] candidate query failed', pgCode ? { pgCode } : {});
        break;
      }
      summary.pages += 1;
      if (page.length === 0) {
        if (resumeCursor !== null) summary.cursor_wrapped = true;
        resumeCursor = null;
        break;
      }
      for (const item of page) {
        if (summary.processed >= scanBudget || committed >= commitBudget) break;
        summary.processed += 1;
        resumeCursor = item.id;
        let result: CleanupItemResult;
        try {
          result = await cleanupOneExpiredPurchase(db, item);
        } catch (err) {
          // Only reachable if connect() itself fails; counted like any error.
          const pgCode = safePgCode(err);
          result = { outcome: 'error', errorClass: 'unknown', ...(pgCode ? { pgCode } : {}) };
        }
        switch (result.outcome) {
          case 'voided':
            committed += 1; // COMMIT succeeded
            summary.voided += 1;
            if (!result.auditOk) summary.audit_errors += 1;
            console.log('[expiredPurchaseCleanup] item', { purchaseId: item.id, companyId: item.company_id, outcome: 'voided' });
            break;
          case 'skipped_busy':
          case 'skipped_missing':
          case 'skipped_resolved':
          case 'skipped_not_expired':
          case 'skipped_lock_timeout':
            summary[result.outcome] += 1;
            break;
          case 'provider_guard':
            summary.provider_guard += 1;
            console.error('[expiredPurchaseCleanup] item', { purchaseId: item.id, companyId: item.company_id, errorClass: 'provider_guard' });
            break;
          case 'error':
            summary.errors += 1;
            console.error('[expiredPurchaseCleanup] item', {
              purchaseId: item.id,
              companyId: item.company_id,
              errorClass: result.errorClass,
              ...(result.pgCode ? { pgCode: result.pgCode } : {}),
            });
            break;
          default:
            summary.anomalies += 1;
            console.error('[expiredPurchaseCleanup] item', { purchaseId: item.id, companyId: item.company_id, errorClass: result.outcome });
        }
      }
      if (page.length < pageSize) {
        // Wrap-around: the next page/tick starts again from the oldest candidate.
        summary.cursor_wrapped = true;
        resumeCursor = null;
        break;
      }
    }
  } finally {
    running = false;
    summary.duration_ms = Date.now() - started;
  }

  const notable =
    summary.voided + summary.skipped_lock_timeout + summary.anomalies + summary.provider_guard + summary.errors + summary.audit_errors > 0;
  if (notable) {
    const { enabled: _e, overlap: _o, ...counters } = summary;
    console.log('[expiredPurchaseCleanup] tick', counters);
  }
  return summary;
}
