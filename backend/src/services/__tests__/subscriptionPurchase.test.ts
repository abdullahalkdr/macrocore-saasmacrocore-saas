import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyPurchaseOnTrustedSuccess,
  confirmPurchase,
  PurchaseError,
  startCheckout,
  voidPurchaseChain,
  LockedPurchaseChain,
} from '../subscriptionPurchase';
import { CHECKOUT_WINDOW_MINUTES } from '../../config/billing';

// ---------------------------------------------------------------------------
// Stage B7 — services/subscriptionPurchase.ts (design v3 §8.3, §9.2–§9.7).
// A scripted fake client records every statement, so these tests assert the
// exact SQL order (locks before clock decisions, writes in the approved
// order) without a database. The disposable-PostgreSQL smoke
// (docs/SMOKE_B7_subscription_purchase_concurrency.js) proves the same SQL
// against real PostgreSQL, triggers and concurrency.
// ---------------------------------------------------------------------------

type Handler = (sql: string, params: unknown[]) => { rows: any[] } | undefined;

interface Fake {
  calls: { sql: string; params: unknown[] }[];
  handlers: [string | RegExp, Handler | { rows: any[] }][];
  released: number;
  poolCalls: { sql: string; params: unknown[] }[];
  poolHandler: Handler | null;
}

let fake: Fake;

function on(match: string | RegExp, response: Handler | { rows: any[] }) {
  fake.handlers.push([match, response]);
}

function makePool() {
  const query = async (sql: string, params: unknown[] = []) => {
    fake.calls.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    for (const [match, response] of fake.handlers) {
      const hit = typeof match === 'string' ? sql.includes(match) : match.test(sql);
      if (!hit) continue;
      if (typeof response === 'function') {
        const out = response(sql, params);
        if (out) return out;
        continue;
      }
      return response;
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return {
    query: async (sql: string, params: unknown[] = []) => {
      fake.poolCalls.push({ sql, params });
      if (!fake.poolHandler) throw new Error(`unexpected pool query: ${sql}`);
      return fake.poolHandler(sql, params) ?? { rows: [] };
    },
    connect: async () => ({
      query,
      release: () => {
        fake.released += 1;
      },
    }),
    // exposed for direct-client tests
    client: { query },
  };
}

const idx = (needle: string | RegExp) =>
  fake.calls.findIndex((c) => (typeof needle === 'string' ? c.sql.includes(needle) : needle.test(c.sql)));
const sqls = () => fake.calls.map((c) => c.sql);
const isWrite = (s: string) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(s);

beforeEach(() => {
  fake = { calls: [], handlers: [], released: 0, poolCalls: [], poolHandler: null };
});

const COMPANY = 'company-1';

function eligibleCompany(overrides: Record<string, unknown> = {}) {
  on('FROM companies WHERE id = $1 FOR UPDATE', { rows: [{ id: COMPANY, plan: 'trial', subscription_status: 'trial', ...overrides }] });
  on('AS has_live', { rows: [{ has_live: false }] });
}

function noOpenPurchase() {
  on('FROM subscription_purchases sp', { rows: [] });
}

function openPurchase(opts: { plan: string; interval: string; unexpired: boolean }) {
  on('FROM subscription_purchases sp', {
    rows: [{ id: 'old-purchase', company_id: COMPANY, subscription_id: 'old-sub', invoice_id: 'old-inv', expires_at: '2026-09-24T10:00:00Z', target_plan: opts.plan, target_interval: opts.interval }],
  });
  on('clock_timestamp() < expires_at AS unexpired', { rows: [{ unexpired: opts.unexpired }] });
}

function voidChainHandlers(attempts: { id: string; status: string }[] = []) {
  on('FROM subscription_purchases WHERE id = $1 FOR UPDATE', {
    rows: [{ id: 'old-purchase', company_id: COMPANY, subscription_id: 'old-sub', invoice_id: 'old-inv', status: 'open' }],
  });
  on('SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE', { rows: [{ id: 'old-sub' }] });
  on('SELECT id, invoice_number, status FROM invoices', { rows: [{ id: 'old-inv', invoice_number: 'MC-SUB-000009', status: 'issued' }] });
  on('FROM payment_attempts WHERE invoice_id', { rows: attempts });
  on('FROM payment_checkout_sessions WHERE payment_attempt_id', { rows: [{ id: 'old-session', status: 'pending' }] });
  on('UPDATE payment_attempts SET status', { rows: [{ id: 'old-attempt', status: 'cancelled', cancelled_at: '2026-09-24T10:00:00Z' }] });
  on('UPDATE payment_checkout_sessions SET status', { rows: [{ id: 'old-session', status: 'cancelled', resolved_at: '2026-09-24T10:00:00Z' }] });
  on("UPDATE invoices SET status = 'void'", { rows: [{ id: 'old-inv' }] });
  on("UPDATE subscriptions SET status = 'abandoned'", { rows: [{ id: 'old-sub' }] });
  on("UPDATE subscription_purchases SET status = 'void'", { rows: [{ id: 'old-purchase' }] });
}

function creationHandlers() {
  on('INSERT INTO subscriptions', { rows: [{ id: 'new-sub' }] });
  on('INSERT INTO invoices', { rows: [{ id: 'new-inv', invoice_number: 'MC-SUB-000010' }] });
  on('INSERT INTO subscription_purchases', { rows: [{ id: 'new-purchase' }] });
}

const INPUT = { companyId: COMPANY, plan: 'silver' as const, interval: 'annual' as const, currency: 'USD', amountText: '384.00' };

describe('confirmPurchase — creation (design v3 §8.3 / §9.2)', () => {
  it('locks company, checks eligibility, locks open purchase, then inserts sub -> invoice -> purchase with one COMMIT', async () => {
    eligibleCompany();
    noOpenPurchase();
    creationHandlers();
    const pool = makePool();

    const result = await confirmPurchase(pool as any, INPUT);

    expect(result).toEqual({
      kind: 'created', purchaseId: 'new-purchase', invoiceId: 'new-inv', invoiceNumber: 'MC-SUB-000010', subscriptionId: 'new-sub', voided: null,
    });
    const order = [
      idx('BEGIN'),
      idx('FROM companies WHERE id = $1 FOR UPDATE'),
      idx('AS has_live'),
      idx('FROM subscription_purchases sp'),
      idx('INSERT INTO subscriptions'),
      idx('INSERT INTO invoices'),
      idx('INSERT INTO subscription_purchases'),
      idx('COMMIT'),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(fake.released).toBe(1);
  });

  it('captures confirmed_at ONCE with clock_timestamp() in a CTE, never now(); money is a numeric string param', async () => {
    eligibleCompany();
    noOpenPurchase();
    creationHandlers();
    await confirmPurchase(makePool() as any, INPUT);

    const insertSub = fake.calls[idx('INSERT INTO subscriptions')];
    expect(insertSub.sql).toMatch(/WITH c AS \(SELECT clock_timestamp\(\) AS confirmed_at\)/);
    expect((insertSub.sql.match(/clock_timestamp\(\)/g) || []).length).toBe(1);
    expect(insertSub.sql).not.toMatch(/\bnow\(\)/);
    expect(insertSub.sql).toContain("'pending_payment'");
    expect(insertSub.sql).toContain('$4::numeric');
    expect(insertSub.sql).toContain("AT TIME ZONE 'UTC'");
    expect(insertSub.params).toEqual([COMPANY, 'silver', 'USD', '384.00', 'annual']);
    for (const p of insertSub.params) expect(typeof p).toBe('string');
  });

  it('derives invoice issue/due/period and purchase created_at/expires_at in SQL from the stored current_period_start (no JS timestamps)', async () => {
    eligibleCompany();
    noOpenPurchase();
    creationHandlers();
    await confirmPurchase(makePool() as any, INPUT);

    const invoice = fake.calls[idx('INSERT INTO invoices')];
    expect(invoice.sql).toMatch(/SELECT company_id, id, plan, billing_interval, currency, period_amount,\s+current_period_start, current_period_end, 'issued', current_period_start, current_period_start\s+FROM subscriptions WHERE id = \$1/);
    expect(invoice.params).toEqual(['new-sub']);

    const purchase = fake.calls[idx('INSERT INTO subscription_purchases')];
    expect(purchase.sql).toContain('s.current_period_start + make_interval(mins => $3::int)');
    expect(purchase.sql).toMatch(/SELECT s\.company_id, s\.id, \$2::uuid, s\.current_period_start,/);
    expect(purchase.params).toEqual(['new-sub', 'new-inv', CHECKOUT_WINDOW_MINUTES]);
    expect(CHECKOUT_WINDOW_MINUTES).toBe(30);
    for (const call of fake.calls) {
      for (const p of call.params) expect(p instanceof Date).toBe(false);
    }
  });

  it('replays an UNEXPIRED open purchase for the same plan/interval: COMMIT, no insert, no void', async () => {
    eligibleCompany();
    openPurchase({ plan: 'silver', interval: 'annual', unexpired: true });
    const result = await confirmPurchase(makePool() as any, INPUT);
    expect(result).toEqual({ kind: 'replayed', purchaseId: 'old-purchase' });
    expect(sqls().some((s) => s.includes('INSERT'))).toBe(false);
    expect(sqls().some((s) => s.includes("'void'"))).toBe(false);
    expect(sqls()).toContain('COMMIT');
    // The expiry decision was a separate clock statement after the purchase lock.
    expect(idx('clock_timestamp() < expires_at AS unexpired')).toBeGreaterThan(idx('FROM subscription_purchases sp'));
  });

  it('a DIFFERENT plan supersedes: voids the old chain (reason superseded) before creating the new one', async () => {
    eligibleCompany();
    openPurchase({ plan: 'bronze', interval: 'monthly', unexpired: true });
    voidChainHandlers([{ id: 'old-attempt', status: 'initiated' }]);
    creationHandlers();
    const result = await confirmPurchase(makePool() as any, INPUT);
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('unreachable');
    expect(result.voided).toMatchObject({ purchase_id: 'old-purchase', reason: 'superseded', invoice_number: 'MC-SUB-000009', cancelled_payment_attempt_ids: ['old-attempt'] });
    expect(idx("UPDATE subscription_purchases SET status = 'void'")).toBeLessThan(idx('INSERT INTO subscriptions'));
  });

  it('an EXPIRED open purchase for the same plan is voided (reason expired_superseded), never replayed', async () => {
    eligibleCompany();
    openPurchase({ plan: 'silver', interval: 'annual', unexpired: false });
    voidChainHandlers([]);
    creationHandlers();
    const result = await confirmPurchase(makePool() as any, INPUT);
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('unreachable');
    expect(result.voided?.reason).toBe('expired_superseded');
  });

  it.each([
    ['suspended company', { subscription_status: 'suspended' }, false],
    ['cancelled company', { subscription_status: 'cancelled' }, false],
    ['active company', { subscription_status: 'active' }, false],
    ['trial company with a live subscription', {}, true],
  ])('%s -> 409 NOT_ELIGIBLE, ROLLBACK, zero writes', async (_label, overrides, hasLive) => {
    on('FROM companies WHERE id = $1 FOR UPDATE', { rows: [{ id: COMPANY, plan: 'trial', subscription_status: 'trial', ...overrides }] });
    on('AS has_live', { rows: [{ has_live: hasLive }] });
    const pool = makePool();
    await expect(confirmPurchase(pool as any, INPUT)).rejects.toMatchObject({ status: 409, code: 'NOT_ELIGIBLE' });
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
    expect(sqls().some(isWrite)).toBe(false);
    expect(fake.released).toBe(1);
  });

  it('a unique-violation backstop on the one-open index replays via the plain pool, never the rolled-back client', async () => {
    eligibleCompany();
    noOpenPurchase();
    on('INSERT INTO subscriptions', { rows: [{ id: 'new-sub' }] });
    on('INSERT INTO invoices', { rows: [{ id: 'new-inv', invoice_number: 'MC-SUB-000010' }] });
    on('INSERT INTO subscription_purchases', () => {
      const err: any = new Error('duplicate key');
      err.code = '23505';
      err.constraint = 'subscription_purchases_one_open_per_company';
      throw err;
    });
    fake.poolHandler = () => ({ rows: [{ id: 'concurrent-purchase', plan: 'silver', billing_interval: 'annual', unexpired: true }] });
    const result = await confirmPurchase(makePool() as any, INPUT);
    expect(result).toEqual({ kind: 'replayed', purchaseId: 'concurrent-purchase' });
    expect(sqls()).toContain('ROLLBACK');
    expect(fake.poolCalls).toHaveLength(1);
  });

  it('the backstop reports 409 PURCHASE_CONFLICT when the concurrent open purchase is for another plan', async () => {
    eligibleCompany();
    noOpenPurchase();
    on('INSERT INTO subscriptions', () => {
      const err: any = new Error('duplicate key');
      err.code = '23505';
      err.constraint = 'subscription_purchases_one_open_per_company';
      throw err;
    });
    fake.poolHandler = () => ({ rows: [{ id: 'x', plan: 'gold', billing_interval: 'annual', unexpired: true }] });
    await expect(confirmPurchase(makePool() as any, INPUT)).rejects.toMatchObject({ status: 409, code: 'PURCHASE_CONFLICT' });
  });

  it('any other error rolls back and propagates', async () => {
    eligibleCompany();
    noOpenPurchase();
    on('INSERT INTO subscriptions', () => {
      throw new Error('boom');
    });
    await expect(confirmPurchase(makePool() as any, INPUT)).rejects.toThrow('boom');
    expect(sqls()).toContain('ROLLBACK');
    expect(fake.released).toBe(1);
  });
});

describe('startCheckout (design v3 §9.3)', () => {
  function checkoutBase(opts: { status?: string; attempts?: { id: string; status: string }[]; session?: any; unexpired?: boolean } = {}) {
    on('SELECT id FROM companies WHERE id = $1 FOR UPDATE', { rows: [{ id: COMPANY }] });
    on('FROM subscription_purchases WHERE id = $1 AND company_id = $2 FOR UPDATE', {
      rows: [{ id: 'purchase-1', company_id: COMPANY, subscription_id: 'sub-1', invoice_id: 'inv-1', status: opts.status ?? 'open' }],
    });
    on('SELECT id, status FROM subscriptions WHERE id = $1 FOR UPDATE', { rows: [{ id: 'sub-1', status: 'pending_payment' }] });
    on('SELECT id, status FROM invoices WHERE id = $1 FOR UPDATE', { rows: [{ id: 'inv-1', status: 'issued' }] });
    on('FROM payment_attempts WHERE invoice_id = $1 ORDER BY created_at, id FOR UPDATE', { rows: opts.attempts ?? [] });
    on('FROM payment_checkout_sessions WHERE payment_attempt_id', { rows: opts.session ? [opts.session] : [] });
    on('clock_timestamp() < expires_at AS unexpired', { rows: [{ unexpired: opts.unexpired ?? true }] });
    on('INSERT INTO payment_attempts', { rows: [{ id: 'attempt-new' }] });
    on('INSERT INTO payment_checkout_sessions', { rows: [{ id: 'session-new' }] });
  }

  it('creates attempt #1 with the server key b7:<purchase>:1 and a pending session; clock check comes after every lock', async () => {
    checkoutBase();
    const result = await startCheckout(makePool() as any, COMPANY, 'purchase-1');
    expect(result).toMatchObject({ attemptId: 'attempt-new', sessionId: 'session-new', attemptCreated: true, sessionCreated: true });
    const attemptInsert = fake.calls[idx('INSERT INTO payment_attempts')];
    expect(attemptInsert.params).toEqual(['inv-1', 'b7:purchase-1:1']);
    expect(attemptInsert.sql).toContain('FROM invoices WHERE id = $1');
    const clock = idx('clock_timestamp() < expires_at');
    for (const lock of ['FROM companies', 'FROM subscription_purchases WHERE id', 'FROM subscriptions WHERE id', 'FROM invoices WHERE id', 'FROM payment_attempts WHERE invoice_id']) {
      expect(idx(lock)).toBeLessThan(clock);
    }
    expect(fake.calls[clock].sql).not.toMatch(/\bnow\(\)/);
    expect(clock).toBeLessThan(idx('INSERT INTO payment_attempts'));
  });

  it('attempt n+1 after failed/cancelled attempts', async () => {
    checkoutBase({ attempts: [{ id: 'a1', status: 'failed' }, { id: 'a2', status: 'cancelled' }] });
    await startCheckout(makePool() as any, COMPANY, 'purchase-1');
    expect(fake.calls[idx('INSERT INTO payment_attempts')].params).toEqual(['inv-1', 'b7:purchase-1:3']);
  });

  it('reuses an initiated attempt and its pending session (refresh / double click): no insert', async () => {
    checkoutBase({ attempts: [{ id: 'a1', status: 'initiated' }], session: { id: 's1', status: 'pending' } });
    const result = await startCheckout(makePool() as any, COMPANY, 'purchase-1');
    expect(result).toMatchObject({ attemptId: 'a1', sessionId: 's1', attemptCreated: false, sessionCreated: false });
    expect(sqls().some((s) => s.includes('INSERT'))).toBe(false);
  });

  it('an EXPIRED purchase -> 409 PURCHASE_EXPIRED with zero writes, even with a pending session', async () => {
    checkoutBase({ attempts: [{ id: 'a1', status: 'initiated' }], session: { id: 's1', status: 'pending' }, unexpired: false });
    await expect(startCheckout(makePool() as any, COMPANY, 'purchase-1')).rejects.toMatchObject({ status: 409, code: 'PURCHASE_EXPIRED' });
    expect(sqls().some(isWrite)).toBe(false);
    expect(sqls()).toContain('ROLLBACK');
  });

  it('a closed purchase -> 409 PURCHASE_CLOSED', async () => {
    checkoutBase({ status: 'void' });
    await expect(startCheckout(makePool() as any, COMPANY, 'purchase-1')).rejects.toMatchObject({ status: 409, code: 'PURCHASE_CLOSED' });
  });

  it("another tenant's purchase id -> 404 (lookup is scoped by company_id)", async () => {
    on('SELECT id FROM companies WHERE id = $1 FOR UPDATE', { rows: [{ id: COMPANY }] });
    on('FROM subscription_purchases WHERE id = $1 AND company_id = $2 FOR UPDATE', { rows: [] });
    await expect(startCheckout(makePool() as any, COMPANY, 'foreign')).rejects.toMatchObject({ status: 404 });
    const lookup = fake.calls[idx('AND company_id = $2')];
    expect(lookup.params).toEqual(['foreign', COMPANY]);
  });

  it('a succeeded attempt already exists -> 409 PURCHASE_CLOSED (defensive)', async () => {
    checkoutBase({ attempts: [{ id: 'a1', status: 'succeeded' }] });
    await expect(startCheckout(makePool() as any, COMPANY, 'purchase-1')).rejects.toBeInstanceOf(PurchaseError);
  });
});

describe('voidPurchaseChain (design v3 §9.6)', () => {
  it('refuses a purchase that is no longer open', async () => {
    on('FROM subscription_purchases WHERE id = $1 FOR UPDATE', { rows: [{ id: 'p', status: 'completed' }] });
    const pool = makePool();
    await expect(voidPurchaseChain(pool.client as any, 'p', 'superseded')).rejects.toThrow(/not 'open'/);
    expect(sqls().some(isWrite)).toBe(false);
  });

  it('cancels the initiated attempt + session via settleOutcome, then invoice void -> sub abandoned -> purchase void', async () => {
    voidChainHandlers([{ id: 'old-attempt', status: 'initiated' }, { id: 'old-failed', status: 'failed' }]);
    const pool = makePool();
    const snapshot = await voidPurchaseChain(pool.client as any, 'old-purchase', 'expired_admin_action');
    expect(snapshot).toEqual({
      purchase_id: 'old-purchase', reason: 'expired_admin_action', invoice_id: 'old-inv', invoice_number: 'MC-SUB-000009',
      subscription_id: 'old-sub', company_id: COMPANY, cancelled_payment_attempt_ids: ['old-attempt'],
    });
    const order = [
      idx('FROM subscription_purchases WHERE id = $1 FOR UPDATE'),
      idx('SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE'),
      idx('SELECT id, invoice_number, status FROM invoices'),
      idx('FROM payment_attempts WHERE invoice_id'),
      idx('UPDATE payment_attempts SET status'),
      idx('UPDATE payment_checkout_sessions SET status'),
      idx("UPDATE invoices SET status = 'void'"),
      idx("UPDATE subscriptions SET status = 'abandoned'"),
      idx("UPDATE subscription_purchases SET status = 'void'"),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(fake.calls[idx('UPDATE payment_attempts SET status')].params).toEqual(['old-attempt', 'cancelled']);
    expect(fake.calls.filter((c) => c.sql.includes('UPDATE payment_attempts')).length).toBe(1);
  });

  it('throws when any guarded UPDATE does not hit exactly one row', async () => {
    voidChainHandlers([]);
    fake.handlers.unshift(["UPDATE invoices SET status = 'void'", { rows: [] }]);
    await expect(voidPurchaseChain(makePool().client as any, 'old-purchase', 'superseded')).rejects.toThrow(/exactly one row/);
  });
});

describe('applyPurchaseOnTrustedSuccess (design v3 §9.5)', () => {
  const LOCKED: LockedPurchaseChain = {
    company: { id: COMPANY, plan: 'trial', subscription_status: 'trial' },
    purchase: { id: 'purchase-1', status: 'open', subscription_id: 'sub-1', invoice_id: 'inv-1' },
    pendingSub: { id: 'sub-1', status: 'pending_payment', plan: 'gold' },
    attempt: { id: 'attempt-1' },
    session: { id: 'session-1' },
    invoice: { id: 'inv-1' },
  };

  function applyHandlers(opts: { hasLive?: boolean; subRows?: any[] } = {}) {
    on('AS has_live', { rows: [{ has_live: opts.hasLive ?? false }] });
    on('UPDATE payment_attempts SET status', { rows: [{ id: 'attempt-1', status: 'succeeded', succeeded_at: '2026-09-24T09:00:00Z' }] });
    on('UPDATE payment_checkout_sessions SET status', { rows: [{ id: 'session-1', status: 'succeeded', resolved_at: '2026-09-24T09:00:00Z' }] });
    on("UPDATE invoices SET status = 'paid'", { rows: [{ id: 'inv-1', status: 'paid', payment_date: '2026-09-24T09:00:00Z' }] });
    on("UPDATE subscriptions SET status = 'active'", {
      rows: opts.subRows ?? [{ id: 'sub-1', plan: 'gold', billing_interval: 'annual', current_period_start: '2026-09-24T08:40:00Z', current_period_end: '2027-09-24T08:40:00Z' }],
    });
    on('UPDATE companies SET plan', { rows: [] });
    on('UPDATE email_jobs', { rows: [] });
    on("UPDATE subscription_purchases SET status = 'completed'", { rows: [{ completed_at: '2026-09-24T09:00:01Z' }] });
  }

  it('DELAYED-CALLBACK PROOF: takes no clock input and issues no expiry query — an already-expired open purchase is still applied', async () => {
    applyHandlers();
    // Whatever the purchase's expires_at is (even long past), this function
    // has no way to see or check it.
    const { applied, settle } = await applyPurchaseOnTrustedSuccess(makePool().client as any, LOCKED);
    expect(applied).toMatchObject({
      purchase_id: 'purchase-1', subscription_id: 'sub-1',
      old_values: { plan: 'trial', subscription_status: 'trial' }, new_values: { plan: 'gold', subscription_status: 'active' },
    });
    expect(settle.invoiceNewStatus).toBe('paid');
    // No statement reads the clock or the deadline (B6's own invoice
    // payment_date = now() stamp inside settleOutcome is a write, not a check).
    expect(sqls().some((s) => /clock_timestamp|expires_at/.test(s))).toBe(false);
  });

  it('writes in the approved order: settle (attempt/session/invoice) -> sub active -> company -> trial emails -> purchase completed', async () => {
    applyHandlers();
    await applyPurchaseOnTrustedSuccess(makePool().client as any, LOCKED);
    const order = [
      idx('AS has_live'),
      idx('UPDATE payment_attempts SET status'),
      idx('UPDATE payment_checkout_sessions SET status'),
      idx("UPDATE invoices SET status = 'paid'"),
      idx("UPDATE subscriptions SET status = 'active'"),
      idx('UPDATE companies SET plan'),
      idx('UPDATE email_jobs'),
      idx("UPDATE subscription_purchases SET status = 'completed'"),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(fake.calls[idx('UPDATE companies SET plan')].params).toEqual(['gold', COMPANY]);
  });

  it.each([
    ['purchase not open', { purchase: { ...LOCKED.purchase, status: 'void' } }],
    ['pending sub not pending_payment', { pendingSub: { ...LOCKED.pendingSub, status: 'abandoned' } }],
    ['company not trial', { company: { ...LOCKED.company, subscription_status: 'suspended' } }],
  ])('integrity assertion (%s) throws before any write', async (_label, patch) => {
    applyHandlers();
    await expect(applyPurchaseOnTrustedSuccess(makePool().client as any, { ...LOCKED, ...patch } as LockedPurchaseChain)).rejects.toThrow(/applyPurchaseOnTrustedSuccess/);
    expect(sqls().some(isWrite)).toBe(false);
  });

  it('a live subscription already existing throws before any write', async () => {
    applyHandlers({ hasLive: true });
    await expect(applyPurchaseOnTrustedSuccess(makePool().client as any, LOCKED)).rejects.toThrow(/live subscription/);
    expect(sqls().some(isWrite)).toBe(false);
  });

  it('a pending_payment -> active UPDATE hitting zero rows throws (caller rolls back)', async () => {
    applyHandlers({ subRows: [] });
    await expect(applyPurchaseOnTrustedSuccess(makePool().client as any, LOCKED)).rejects.toThrow(/exactly one row/);
  });
});
