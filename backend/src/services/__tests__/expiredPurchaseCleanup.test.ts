import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Stage B8.2 — services/expiredPurchaseCleanup.ts unit tests
// (design v3 §5, §8, §11; test matrix §12: L1–L3, L4/L7/L8 budget logic,
// F2–F4, X4, C10 shape). A scripted fake database records every statement so
// the lock order, the post-lock clock read and the budgets are asserted
// exactly. Real PostgreSQL behaviour (triggers, SKIP LOCKED, races) is proven
// by docs/SMOKE_B8_2_expired_purchase_cleanup.js.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  env: { ENABLE_BACKGROUND_SWEEPS: true, ENABLE_EXPIRED_PURCHASE_CLEANUP: true, FRONTEND_URL: 'https://app.example.test' } as Record<string, unknown>,
  logAudit: vi.fn(),
}));
vi.mock('../../config/env', () => ({ env: mocks.env }));
vi.mock('../../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../../utils/audit', () => ({ logAudit: mocks.logAudit }));

import {
  cleanupOneExpiredPurchase,
  getExpiredPurchaseCleanupCursor,
  resetExpiredPurchaseCleanupState,
  sweepExpiredPurchases,
} from '../expiredPurchaseCleanup';

type Att = { id: string; status: string; session?: { status: string; provider?: string } | null };
interface FakePurchase {
  id: string;
  company: string;
  status?: string;
  replaces?: string | null;
  sourceStatus?: string;
  pendingStatus?: string;
  invoiceStatus?: string;
  attempts?: Att[];
  expired?: boolean;
  busy?: boolean;
  missing?: boolean;
  failAt?: string; // SQL prefix that throws
  failCode?: string;
}

let purchases: FakePurchase[];
let calls: { sql: string; params: unknown[]; conn: number }[];
let connections: number;
let released: number;

function makeDb() {
  const byId = (id: unknown) => purchases.find((p) => p.id === id);
  const byInvoice = (inv: unknown) => purchases.find((p) => `inv-${p.id}` === inv);
  const make = (conn: number) => {
    let current: FakePurchase | undefined;
    const query = async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params, conn });
      if (current?.failAt && sql.startsWith(current.failAt)) {
        throw Object.assign(new Error('injected failure with private data secret@example.test'), { code: current.failCode ?? 'XX000' });
      }
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.includes('FROM subscription_purchases sp') && sql.includes('LIMIT $1')) {
        // Mirrors the real keyset: rows strictly after the cursor row in the
        // fixed (expires_at, id) order, whatever the cursor row's status now is.
        const [limit, after] = params as [number, string | null];
        const start = after ? purchases.findIndex((p) => p.id === after) + 1 : 0;
        const open = purchases.slice(start).filter((p) => (p.status ?? 'open') === 'open' && p.expired !== false);
        return { rows: open.slice(0, limit).map((p) => ({ id: p.id, company_id: p.company })) };
      }
      if (sql.includes('FROM companies WHERE id = $1 FOR UPDATE SKIP LOCKED')) {
        current = purchases.find((p) => p.company === params[0]);
        return { rows: current && current.busy ? [] : [{ id: params[0] }] };
      }
      if (sql.includes('FROM subscription_purchases WHERE id = $1 AND company_id = $2 FOR UPDATE')) {
        const p = byId(params[0]);
        if (!p || p.missing || p.company !== params[1]) return { rows: [] };
        current = p;
        return { rows: [{ id: p.id, company_id: p.company, subscription_id: `sub-${p.id}`, invoice_id: `inv-${p.id}`, status: p.status ?? 'open', replaces_subscription_id: p.replaces ?? null }] };
      }
      if (sql.includes('FROM subscriptions WHERE id = $1 AND company_id = $2 FOR UPDATE') && sql.startsWith('SELECT id, company_id, status')) {
        const p = current!;
        if (p.replaces && params[0] === p.replaces) return { rows: p.sourceStatus === 'missing' ? [] : [{ id: p.replaces, company_id: p.company, status: p.sourceStatus ?? 'active' }] };
        return { rows: [{ id: params[0], company_id: p.company, status: p.pendingStatus ?? 'pending_payment' }] };
      }
      if (sql.includes('FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE')) {
        const p = byInvoice(params[0])!;
        return { rows: [{ id: params[0], company_id: p.company, invoice_number: `MC-${p.id}`, status: p.invoiceStatus ?? 'issued' }] };
      }
      if (sql.includes('FROM payment_attempts WHERE invoice_id')) {
        const p = byInvoice(params[0])!;
        return { rows: (p.attempts ?? []).map((a) => ({ id: a.id, status: a.status })) };
      }
      if (sql.includes('FROM payment_checkout_sessions WHERE payment_attempt_id')) {
        const a = (current!.attempts ?? []).find((x) => x.id === params[0]);
        return { rows: a && a.session ? [{ id: `${a.id}-s`, status: a.session.status, provider: a.session.provider ?? 'simulated' }] : [] };
      }
      if (sql.includes('AS expired_unresolved')) return { rows: [{ expired_unresolved: current!.expired !== false }] };
      if (sql.startsWith('UPDATE payment_attempts')) return { rows: [{ id: params[0], status: 'cancelled', cancelled_at: '2026-09-27T00:00:00Z' }] };
      if (sql.startsWith('UPDATE payment_checkout_sessions')) return { rows: [{ id: params[0], status: 'cancelled', resolved_at: '2026-09-27T00:00:00Z' }] };
      if (sql.startsWith('UPDATE subscription_purchases')) {
        current!.status = 'void';
        return { rows: [{ id: params[0] }] };
      }
      if (sql.startsWith('UPDATE')) return { rows: [{ id: params[0] }] };
      throw new Error(`unexpected query: ${sql}`);
    };
    return query;
  };
  const poolQuery = make(0);
  return {
    query: poolQuery,
    connect: async () => {
      connections += 1;
      const q = make(connections);
      return { query: q, release: () => { released += 1; } };
    },
  };
}

const isWrite = (s: string) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(s);
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  purchases = [];
  calls = [];
  connections = 0;
  released = 0;
  mocks.env.ENABLE_BACKGROUND_SWEEPS = true;
  mocks.env.ENABLE_EXPIRED_PURCHASE_CLEANUP = true;
  mocks.logAudit.mockReset();
  mocks.logAudit.mockResolvedValue(true);
  resetExpiredPurchaseCleanupState();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

const seq = (n: number, over: Partial<FakePurchase> = {}, prefix = 'p') =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i).padStart(3, '0')}`, company: `c-${prefix}${i}`, ...over }));

describe('cleanupOneExpiredPurchase — lock order and the post-lock clock read (design v3 §5.2)', () => {
  it('upgrade: company SKIP LOCKED -> purchase -> source -> pending -> invoice -> attempts -> every session -> clock -> writes -> COMMIT', async () => {
    purchases = [{ id: 'p1', company: 'c1', replaces: 'src-1', attempts: [
      { id: 'a1', status: 'failed', session: { status: 'failed' } },
      { id: 'a2', status: 'initiated', session: { status: 'pending' } },
    ] }];
    const r = await cleanupOneExpiredPurchase(makeDb() as any, { id: 'p1', company_id: 'c1' });
    expect(r.outcome).toBe('voided');
    expect(r.snapshot).toMatchObject({ reason: 'expired_cleanup', cancelled_payment_attempt_ids: ['a2'] });
    const sqls = calls.map((c) => c.sql);
    const at = (needle: string, from = 0) => sqls.findIndex((s, i) => i >= from && s.includes(needle));
    const order = [
      at('BEGIN'),
      at('SET LOCAL lock_timeout'),
      at('FROM companies WHERE id = $1 FOR UPDATE SKIP LOCKED'),
      at('FROM subscription_purchases WHERE id = $1 AND company_id = $2 FOR UPDATE'),
      at('FROM subscriptions WHERE id = $1 AND company_id = $2 FOR UPDATE'), // source
      at('FROM subscriptions WHERE id = $1 AND company_id = $2 FOR UPDATE', at('FROM subscriptions WHERE id = $1 AND company_id = $2 FOR UPDATE') + 1), // pending
      at('FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE'),
      at('FROM payment_attempts WHERE invoice_id'),
      at('FROM payment_checkout_sessions'),
      at('AS expired_unresolved'),
      at('UPDATE payment_attempts'),
      at("UPDATE subscription_purchases SET status = 'void'"),
      at('COMMIT'),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const source = calls.find((c) => c.sql.includes('FROM subscriptions WHERE id = $1 AND company_id = $2') && c.params[0] === 'src-1');
    expect(source?.params).toEqual(['src-1', 'c1']);
    // Sessions of BOTH attempts are locked; the source is never written.
    expect(calls.filter((c) => c.sql.includes('FROM payment_checkout_sessions')).map((c) => c.params[0])).toEqual(['a1', 'a2']);
    expect(calls.some((c) => isWrite(c.sql) && c.params.includes('src-1'))).toBe(false);
    // Clock decision strictly after the last lock and before the first write.
    const lastLock = Math.max(...sqls.map((s, i) => (/FOR UPDATE/.test(s) ? i : -1)));
    expect(at('AS expired_unresolved')).toBeGreaterThan(lastLock);
    expect(at('AS expired_unresolved')).toBeLessThan(sqls.findIndex(isWrite));
    expect(calls.find((c) => c.sql.includes('AS expired_unresolved'))!.sql).toContain('clock_timestamp() >= expires_at');
    expect(sqls.some((s) => /\bnow\(\)/.test(s))).toBe(false);
    expect(sqls.some((s) => s.includes('email_jobs'))).toBe(false);
    expect(released).toBe(1);
    // Post-commit audit: system actor, no req, reason expired_cleanup.
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    const audit = mocks.logAudit.mock.calls[0][0];
    expect(audit).toMatchObject({ companyId: 'c1', userId: null, action: 'subscription_purchase_voided', entityId: 'p1' });
    expect(audit.req).toBeUndefined();
    expect(audit.newValues).toMatchObject({ status: 'void', reason: 'expired_cleanup', actor: 'system_expired_purchase_cleanup', replaces_subscription_id: 'src-1' });
  });

  it.each([
    ['busy company -> skipped_busy', { busy: true }, 'skipped_busy'],
    ['purchase gone / other tenant -> skipped_missing', { missing: true }, 'skipped_missing'],
    ['already completed -> skipped_resolved', { status: 'completed' }, 'skipped_resolved'],
    ['already void -> skipped_resolved', { status: 'void' }, 'skipped_resolved'],
    ['not expired under the post-lock read -> skipped_not_expired', { expired: false }, 'skipped_not_expired'],
    ['source not active -> anomaly_source', { replaces: 'src', sourceStatus: 'superseded' }, 'anomaly_source'],
    ['source missing -> anomaly_source', { replaces: 'src', sourceStatus: 'missing' }, 'anomaly_source'],
    ['pending not pending_payment -> anomaly_pending', { pendingStatus: 'active' }, 'anomaly_pending'],
    ['invoice paid -> anomaly_invoice', { invoiceStatus: 'paid' }, 'anomaly_invoice'],
    ['succeeded attempt -> anomaly_attempt', { attempts: [{ id: 'a', status: 'succeeded', session: { status: 'succeeded' } }] }, 'anomaly_attempt'],
    ['failed + pending session -> anomaly_session', { attempts: [{ id: 'a', status: 'failed', session: { status: 'pending' } }] }, 'anomaly_session'],
    ['cancelled + failed session -> anomaly_session', { attempts: [{ id: 'a', status: 'cancelled', session: { status: 'failed' } }] }, 'anomaly_session'],
    ['cancelled + pending session -> anomaly_session', { attempts: [{ id: 'a', status: 'cancelled', session: { status: 'pending' } }] }, 'anomaly_session'],
    ['terminal attempt with a non-simulated session -> provider_guard', { attempts: [{ id: 'a', status: 'failed', session: { status: 'failed', provider: 'myfatoorah' } }] }, 'provider_guard'],
  ] as [string, Partial<FakePurchase>, string][])('%s, zero writes, ROLLBACK', async (_label, over, outcome) => {
    purchases = [{ id: 'p1', company: 'c1', ...over }];
    const r = await cleanupOneExpiredPurchase(makeDb() as any, { id: 'p1', company_id: 'c1' });
    expect(r.outcome).toBe(outcome);
    expect(calls.some((c) => isWrite(c.sql))).toBe(false);
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(calls.map((c) => c.sql)).not.toContain('COMMIT');
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(released).toBe(1);
  });

  it('cross-tenant substitution (purchase of c1 presented with company c2) -> skipped_missing, zero writes', async () => {
    purchases = [{ id: 'p1', company: 'c1' }, { id: 'p2', company: 'c2' }];
    const r = await cleanupOneExpiredPurchase(makeDb() as any, { id: 'p1', company_id: 'c2' });
    expect(r.outcome).toBe('skipped_missing');
    expect(calls.some((c) => isWrite(c.sql))).toBe(false);
  });

  it('lock_timeout (55P03) -> skipped_lock_timeout with ROLLBACK', async () => {
    purchases = [{ id: 'p1', company: 'c1', failAt: 'SELECT id, company_id, invoice_number, status FROM invoices', failCode: '55P03' }];
    const r = await cleanupOneExpiredPurchase(makeDb() as any, { id: 'p1', company_id: 'c1' });
    expect(r.outcome).toBe('skipped_lock_timeout');
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK');
  });

  it('a throw in the write phase -> error/void, ROLLBACK, no audit; a COMMIT failure -> error/commit', async () => {
    purchases = [{ id: 'p1', company: 'c1', failAt: "UPDATE invoices SET status = 'void'", failCode: '23514' }];
    const r1 = await cleanupOneExpiredPurchase(makeDb() as any, { id: 'p1', company_id: 'c1' });
    expect(r1).toEqual({ outcome: 'error', errorClass: 'void', pgCode: '23514' });
    expect(mocks.logAudit).not.toHaveBeenCalled();
    calls = [];
    purchases = [{ id: 'p2', company: 'c2', failAt: 'COMMIT', failCode: '08006' }];
    const r2 = await cleanupOneExpiredPurchase(makeDb() as any, { id: 'p2', company_id: 'c2' });
    expect(r2).toEqual({ outcome: 'error', errorClass: 'commit', pgCode: '08006' });
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('post-commit audit failure: still voided, auditOk=false', async () => {
    purchases = [{ id: 'p1', company: 'c1' }];
    mocks.logAudit.mockResolvedValue(false);
    const r = await cleanupOneExpiredPurchase(makeDb() as any, { id: 'p1', company_id: 'c1' });
    expect(r.outcome).toBe('voided');
    expect(r.auditOk).toBe(false);
  });
});

describe('sweepExpiredPurchases — switches, overlap, budgets, cursor (design v3 §5.1, §8.1)', () => {
  it.each([
    [false, true],
    [true, false],
    [true, 'TRUE'],
    [true, '1'],
    [true, undefined],
  ])('BACKGROUND=%s CLEANUP=%s -> no DB access at all', async (bg, cleanup) => {
    mocks.env.ENABLE_BACKGROUND_SWEEPS = bg;
    mocks.env.ENABLE_EXPIRED_PURCHASE_CLEANUP = cleanup === true ? true : cleanup === false ? false : (cleanup as any) === true;
    purchases = seq(3);
    const db = makeDb();
    const s = await sweepExpiredPurchases({ db: db as any });
    expect(s.enabled).toBe(false);
    expect(calls.length).toBe(0);
    expect(connections).toBe(0);
  });

  it('env.ts parses ENABLE_EXPIRED_PURCHASE_CLEANUP fail-closed (exact string "true" only)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(__dirname, '../../config/env.ts'), 'utf-8');
    expect(src).toContain("ENABLE_EXPIRED_PURCHASE_CLEANUP: process.env.ENABLE_EXPIRED_PURCHASE_CLEANUP === 'true'");
  });

  it('overlap guard: a second call while one is in flight is an immediate no-op', async () => {
    purchases = seq(2);
    const db = makeDb();
    const first = sweepExpiredPurchases({ db: db as any });
    const second = await sweepExpiredPurchases({ db: db as any });
    expect(second.overlap).toBe(true);
    expect(second.processed).toBe(0);
    const s1 = await first;
    expect(s1.voided).toBe(2);
    // guard released afterwards
    purchases.push(...seq(1, {}, 'q'));
    expect((await sweepExpiredPurchases({ db: db as any })).voided).toBe(1);
  });

  it('L4: 60 eligible -> each call commits <= 25 voids and processes <= 100; three calls drain all 60, oldest first', async () => {
    purchases = seq(60);
    const db = makeDb();
    const s1 = await sweepExpiredPurchases({ db: db as any });
    expect(s1.voided).toBe(25);
    expect(s1.processed).toBe(25);
    const voidedFirst = calls.filter((c) => c.sql.startsWith("UPDATE subscription_purchases SET status = 'void'")).map((c) => c.params[0]);
    expect(voidedFirst).toEqual(purchases.slice(0, 25).map((p) => p.id));
    const s2 = await sweepExpiredPurchases({ db: db as any });
    const s3 = await sweepExpiredPurchases({ db: db as any });
    expect(s2.voided + s3.voided).toBe(35);
    expect(purchases.every((p) => p.status === 'void')).toBe(true);
  });

  it('L4 variant: 30 oldest throw in the write phase -> counted as errors (not commits); the call stops at the budgets', async () => {
    purchases = [
      ...seq(30, { failAt: "UPDATE invoices SET status = 'void'", failCode: '23514' }, 'f'),
      ...seq(30, {}, 'g'),
    ];
    const db = makeDb();
    const s = await sweepExpiredPurchases({ db: db as any });
    expect(s.errors).toBe(30);
    expect(s.voided).toBe(25);
    expect(s.processed).toBe(55);
    expect(s.processed).toBeLessThanOrEqual(100);
  });

  it('scanBudget is the hard cap: 150 failing candidates -> exactly 100 processed, 0 committed', async () => {
    purchases = seq(150, { failAt: "UPDATE invoices SET status = 'void'" });
    const s = await sweepExpiredPurchases({ db: makeDb() as any });
    expect(s.processed).toBe(100);
    expect(s.errors).toBe(100);
    expect(s.voided).toBe(0);
    expect(s.pages).toBe(4);
  });

  it('L7: 25 persistently unprocessable oldest (12 busy, 13 anomalous) do not block 10 later eligible rows in the same call', async () => {
    purchases = [
      ...seq(12, { busy: true }, 'b'),
      ...seq(13, { invoiceStatus: 'paid' }, 'x'),
      ...seq(10, {}, 'y'),
    ];
    const s = await sweepExpiredPurchases({ db: makeDb() as any });
    expect(s.processed).toBe(35);
    expect(s.voided).toBe(10);
    expect(s.skipped_busy).toBe(12);
    expect(s.anomalies).toBe(13);
    expect(purchases.filter((p) => p.id.startsWith('y')).every((p) => p.status === 'void')).toBe(true);
  });

  it('L7 rotation: scanBudget 20 / pageSize 10 with 30 unprocessable head rows -> later rows voided within 2 calls; each call processes exactly 20', async () => {
    purchases = [...seq(30, { busy: true }, 'b'), ...seq(10, {}, 'y')];
    const db = makeDb();
    const s1 = await sweepExpiredPurchases({ db: db as any, scanBudget: 20, pageSize: 10 });
    expect(s1.processed).toBe(20);
    expect(s1.voided).toBe(0);
    const s2 = await sweepExpiredPurchases({ db: db as any, scanBudget: 20, pageSize: 10 });
    expect(s2.processed).toBe(20);
    expect(s2.voided).toBe(10);
    expect(purchases.filter((p) => p.id.startsWith('y')).every((p) => p.status === 'void')).toBe(true);
  });

  it('L8: after the last (short) page the cursor wraps to null; the next pass starts from the oldest again', async () => {
    purchases = seq(5, { busy: true });
    const db = makeDb();
    const s = await sweepExpiredPurchases({ db: db as any });
    expect(s.cursor_wrapped).toBe(true);
    expect(getExpiredPurchaseCleanupCursor()).toBeNull();
    purchases[0].busy = false;
    const s2 = await sweepExpiredPurchases({ db: db as any });
    expect(s2.voided).toBe(1);
  });

  it('cursor rotation: resumes after the last processed id on the next tick', async () => {
    purchases = seq(30, { busy: true });
    const db = makeDb();
    await sweepExpiredPurchases({ db: db as any, scanBudget: 7, pageSize: 5 });
    expect(getExpiredPurchaseCleanupCursor()).toBe('p006');
    calls = [];
    await sweepExpiredPurchases({ db: db as any, scanBudget: 1, pageSize: 5 });
    const page = calls.find((c) => c.sql.includes('LIMIT $1'))!;
    expect(page.params).toEqual([5, 'p006']);
  });

  it('F2/F4: one failing item and one audit failure do not stop the batch; counters are exact', async () => {
    purchases = [{ id: 'p0', company: 'c0' }, { id: 'p1', company: 'c1', failAt: 'UPDATE subscriptions' }, { id: 'p2', company: 'c2' }];
    mocks.logAudit.mockResolvedValueOnce(false).mockResolvedValue(true);
    const s = await sweepExpiredPurchases({ db: makeDb() as any });
    expect(s).toMatchObject({ processed: 3, voided: 2, errors: 1, audit_errors: 1 });
    expect(purchases[1].status ?? 'open').toBe('open');
  });

  it('F3: a candidate-query failure is logged (no raw message) and the sweep returns without throwing', async () => {
    const db = {
      query: async () => { throw Object.assign(new Error('relation secret_table password=hunter2'), { code: '42P01' }); },
      connect: async () => { throw new Error('should not connect'); },
    };
    const s = await sweepExpiredPurchases({ db: db as any });
    expect(s.errors).toBe(1);
    expect(s.processed).toBe(0);
    const logged = JSON.stringify(errSpy.mock.calls);
    expect(logged).toContain('42P01');
    expect(logged).not.toContain('hunter2');
  });

  it('X4: logs never contain raw messages, emails or tokens; they carry UUID-shaped ids, classes and SQLSTATEs only', async () => {
    purchases = [
      { id: 'p0', company: 'c0', failAt: "UPDATE invoices SET status = 'void'", failCode: '23514' },
      { id: 'p1', company: 'c1', invoiceStatus: 'paid' },
      { id: 'p2', company: 'c2' },
    ];
    await sweepExpiredPurchases({ db: makeDb() as any });
    const logged = JSON.stringify([...errSpy.mock.calls, ...logSpy.mock.calls]);
    expect(logged).not.toContain('secret@example.test');
    expect(logged).not.toContain('injected failure');
    expect(logged).toContain('"errorClass":"void"');
    expect(logged).toContain('"pgCode":"23514"');
    expect(logged).toContain('anomaly_invoice');
    expect(logged).toContain('[expiredPurchaseCleanup] tick');
  });

  it('a quiet tick (only routine skips) logs no tick summary', async () => {
    purchases = seq(3, { busy: true });
    await sweepExpiredPurchases({ db: makeDb() as any });
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('[expiredPurchaseCleanup] tick');
  });
});
