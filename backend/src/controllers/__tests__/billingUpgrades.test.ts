import { beforeEach, describe, expect, it } from 'vitest';
import { confirmPurchase, PurchaseError } from '../../services/subscriptionPurchase';
import { catalogPriceText } from '../../config/planCatalog';
import { CHECKOUT_WINDOW_MINUTES } from '../../config/billing';

// ---------------------------------------------------------------------------
// Stage B8 — paid-to-paid self-service upgrades, confirm path (design v4
// §6.2, §8.3; tests T-API-1 … T-API-5). The REAL confirmPurchase runs against
// a scripted fake client that records every statement, so these tests assert
// the exact lock order, that every rejection performs zero writes, and that
// the source assertion is only ever string-compared (never sent to SQL). The
// disposable-PostgreSQL smoke (docs/SMOKE_B8_subscription_upgrade_concurrency.js)
// proves the same SQL against real PostgreSQL, triggers and concurrency.
// ---------------------------------------------------------------------------

type Handler = (sql: string, params: unknown[]) => { rows: any[] } | undefined;
let calls: { sql: string; params: unknown[] }[];
let handlers: [string, Handler | { rows: any[] }][];
let released: number;

function on(match: string, response: Handler | { rows: any[] }) {
  handlers.push([match, response]);
}
function makePool() {
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    for (const [match, response] of handlers) {
      if (!sql.includes(match)) continue;
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
    query: async (sql: string) => {
      throw new Error(`unexpected pool query: ${sql}`);
    },
    connect: async () => ({ query, release: () => { released += 1; } }),
  };
}
const sqls = () => calls.map((c) => c.sql);
const idx = (needle: string) => calls.findIndex((c) => c.sql.includes(needle));
const isWrite = (s: string) => /^\s*(WITH [\s\S]*?\)\s*)?(INSERT|UPDATE|DELETE)\b/.test(s);

const COMPANY = 'company-1';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  calls = [];
  handlers = [];
  released = 0;
});

interface World {
  companyPlan?: string;
  companyStatus?: string;
  sourcePlan?: string;
  sourceInterval?: string;
  liveRows?: any[] | null;
  unpaid?: boolean;
  // unexpired = the pre-source-lock read inside lockOpenPurchase();
  // unexpiredAfterSourceLock (defaults to unexpired) = the authoritative B8-R1 read.
  open?: null | { plan: string; interval: string; unexpired: boolean; unexpiredAfterSourceLock?: boolean; replaces: string | null };
}

function world(w: World = {}) {
  const sourcePlan = w.sourcePlan ?? 'bronze';
  const sourceInterval = w.sourceInterval ?? 'monthly';
  on('FROM companies WHERE id = $1 FOR UPDATE', {
    rows: [{ id: COMPANY, plan: w.companyPlan ?? sourcePlan, subscription_status: w.companyStatus ?? 'active' }],
  });
  on("SELECT id, plan, status, billing_interval FROM subscriptions WHERE company_id = $1 AND status IN ('active','past_due')", {
    rows: w.liveRows ?? [{ id: SOURCE, plan: sourcePlan, status: 'active', billing_interval: sourceInterval }],
  });
  if (w.open) {
    on('FROM subscription_purchases sp', {
      rows: [{ id: 'old-purchase', company_id: COMPANY, subscription_id: 'old-sub', invoice_id: 'old-inv', expires_at: '2026-09-24T10:00:00Z', target_plan: w.open.plan, target_interval: w.open.interval }],
    });
    const pre = w.open.unexpired;
    const post = w.open.unexpiredAfterSourceLock ?? w.open.unexpired;
    on('clock_timestamp() < expires_at AS unexpired', () => ({
      rows: [{ unexpired: idx('AND company_id = $2 FOR UPDATE') >= 0 ? post : pre }],
    }));
    on('SELECT replaces_subscription_id FROM subscription_purchases WHERE id = $1', { rows: [{ replaces_subscription_id: w.open.replaces }] });
  } else {
    on('FROM subscription_purchases sp', { rows: [] });
  }
  on('SELECT id, company_id, plan, status, billing_interval FROM subscriptions WHERE id = $1 AND company_id = $2 FOR UPDATE', {
    rows: [{ id: SOURCE, company_id: COMPANY, plan: sourcePlan, status: 'active', billing_interval: sourceInterval }],
  });
  on('AS has_unpaid', { rows: [{ has_unpaid: w.unpaid ?? false }] });
}

function voidChain() {
  on('FROM subscription_purchases WHERE id = $1 FOR UPDATE', {
    rows: [{ id: 'old-purchase', company_id: COMPANY, subscription_id: 'old-sub', invoice_id: 'old-inv', status: 'open' }],
  });
  on('SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE', { rows: [{ id: 'old-sub' }] });
  on('SELECT id, invoice_number, status FROM invoices', { rows: [{ id: 'old-inv', invoice_number: 'MC-SUB-000020', status: 'issued' }] });
  on('FROM payment_attempts WHERE invoice_id', { rows: [] });
  on("UPDATE invoices SET status = 'void'", { rows: [{ id: 'old-inv' }] });
  on("UPDATE subscriptions SET status = 'abandoned'", { rows: [{ id: 'old-sub' }] });
  on("UPDATE subscription_purchases SET status = 'void'", { rows: [{ id: 'old-purchase' }] });
}

function creation() {
  on('INSERT INTO subscriptions', { rows: [{ id: 'new-sub' }] });
  on('INSERT INTO invoices', { rows: [{ id: 'new-inv', invoice_number: 'MC-SUB-000021' }] });
  on('INSERT INTO subscription_purchases', { rows: [{ id: 'new-purchase' }] });
}

// expected === null means the request did not carry the field at all.
function input(plan: 'bronze' | 'silver' | 'gold', interval: 'monthly' | 'annual', expected: string | null = SOURCE) {
  return {
    companyId: COMPANY,
    plan,
    interval,
    currency: 'USD',
    amountText: catalogPriceText(plan, interval),
    ...(expected === null ? {} : { expectedSourceSubscriptionId: expected }),
  };
}

async function expectRejected(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ status: 409, code });
  expect(sqls()).toContain('ROLLBACK');
  expect(sqls()).not.toContain('COMMIT');
  expect(sqls().some(isWrite)).toBe(false);
  expect(released).toBe(1);
}

describe('T-API-1 — the six allowed same-interval upgrades', () => {
  it.each([
    ['bronze', 'silver', 'monthly'],
    ['bronze', 'gold', 'monthly'],
    ['silver', 'gold', 'monthly'],
    ['bronze', 'silver', 'annual'],
    ['bronze', 'gold', 'annual'],
    ['silver', 'gold', 'annual'],
  ] as const)('%s -> %s (%s) creates the chain with the server-locked source and the catalogue string', async (from, to, interval) => {
    world({ sourcePlan: from, sourceInterval: interval });
    creation();
    const result = await confirmPurchase(makePool() as any, input(to, interval));
    expect(result).toMatchObject({ kind: 'created', purchaseId: 'new-purchase', upgrade: { replacesSubscriptionId: SOURCE, fromPlan: from } });

    const sub = calls[idx('INSERT INTO subscriptions')];
    expect(sub.params).toEqual([COMPANY, to, 'USD', catalogPriceText(to, interval), interval]);
    expect(typeof sub.params[3]).toBe('string');
    const purchase = calls[idx('INSERT INTO subscription_purchases')];
    expect(purchase.sql).toContain('replaces_subscription_id');
    expect(purchase.params).toEqual(['new-sub', 'new-inv', CHECKOUT_WINDOW_MINUTES, SOURCE]);
    expect(sqls()).toContain('COMMIT');
    // Confirmation writes no company/source change.
    expect(sqls().some((s) => /UPDATE companies|UPDATE subscriptions/.test(s))).toBe(false);
  });

  it('the confirmed_at anchor is one clock_timestamp() captured after every lock and check', async () => {
    world({ sourcePlan: 'bronze', sourceInterval: 'annual' });
    creation();
    await confirmPurchase(makePool() as any, input('gold', 'annual'));
    const insert = idx('INSERT INTO subscriptions');
    for (const before of ['FROM companies WHERE id = $1 FOR UPDATE', 'FROM subscription_purchases sp', 'AND company_id = $2 FOR UPDATE', 'AS has_unpaid']) {
      expect(idx(before)).toBeGreaterThanOrEqual(0);
      expect(idx(before)).toBeLessThan(insert);
    }
    expect(calls[insert].sql).toMatch(/WITH c AS \(SELECT clock_timestamp\(\) AS confirmed_at\)/);
    expect(sqls().some((s) => /\bnow\(\)/.test(s))).toBe(false);
  });
});

describe('T-API-2 — forbidden requests, all with zero writes', () => {
  it.each([
    ['bronze', 'silver', 'monthly', 'annual'],
    ['bronze', 'silver', 'annual', 'monthly'],
    ['bronze', 'gold', 'monthly', 'annual'],
    ['bronze', 'gold', 'annual', 'monthly'],
    ['silver', 'gold', 'monthly', 'annual'],
    ['silver', 'gold', 'annual', 'monthly'],
  ] as const)('%s -> %s from %s to %s -> INTERVAL_CHANGE_NOT_SUPPORTED', async (from, to, srcInterval, reqInterval) => {
    world({ sourcePlan: from, sourceInterval: srcInterval });
    await expectRejected(confirmPurchase(makePool() as any, input(to, reqInterval)), 'INTERVAL_CHANGE_NOT_SUPPORTED');
  });

  it.each([
    ['silver', 'bronze', 'monthly'],
    ['gold', 'silver', 'annual'],
    ['gold', 'bronze', 'monthly'],
    ['bronze', 'bronze', 'monthly'],
    ['bronze', 'bronze', 'annual'], // same plan, other interval: NOT_AN_UPGRADE takes precedence
    ['silver', 'silver', 'annual'],
    ['silver', 'silver', 'monthly'],
    ['gold', 'gold', 'annual'],
    ['gold', 'gold', 'monthly'],
  ] as const)('%s -> %s (%s requested) -> NOT_AN_UPGRADE', async (from, to, reqInterval) => {
    world({ sourcePlan: from, sourceInterval: from === 'bronze' || from === 'silver' ? 'monthly' : 'annual' });
    await expectRejected(confirmPurchase(makePool() as any, input(to, reqInterval)), 'NOT_AN_UPGRADE');
  });

  it('an Enterprise source -> NOT_ELIGIBLE', async () => {
    world({ sourcePlan: 'enterprise', sourceInterval: 'annual' });
    await expectRejected(confirmPurchase(makePool() as any, input('gold', 'annual')), 'NOT_ELIGIBLE');
  });

  it('companies.plan out of step with the live row -> NOT_ELIGIBLE', async () => {
    world({ sourcePlan: 'bronze', companyPlan: 'silver' });
    await expectRejected(confirmPurchase(makePool() as any, input('gold', 'monthly')), 'NOT_ELIGIBLE');
  });

  it.each(['suspended', 'cancelled', 'past_due'])('a %s company -> NOT_ELIGIBLE before any purchase/source lock', async (status) => {
    world({ companyStatus: status });
    await expectRejected(confirmPurchase(makePool() as any, input('gold', 'monthly')), 'NOT_ELIGIBLE');
    expect(idx('FROM subscription_purchases sp')).toBe(-1);
  });

  it('a past_due live row (not active) -> NOT_ELIGIBLE', async () => {
    world({ liveRows: [{ id: SOURCE, plan: 'bronze', status: 'past_due', billing_interval: 'monthly' }] });
    await expectRejected(confirmPurchase(makePool() as any, input('gold', 'monthly')), 'NOT_ELIGIBLE');
  });

  it('no live row / more than one live row -> NOT_ELIGIBLE', async () => {
    world({ liveRows: [] });
    await expectRejected(confirmPurchase(makePool() as any, input('gold', 'monthly')), 'NOT_ELIGIBLE');
  });

  it('an issued (unpaid) source invoice -> UNPAID_INVOICE, checked on the SOURCE subscription id', async () => {
    world({ unpaid: true });
    await expectRejected(confirmPurchase(makePool() as any, input('gold', 'monthly')), 'UNPAID_INVOICE');
    expect(calls[idx('AS has_unpaid')].params).toEqual([SOURCE]);
  });
});

describe('T-API-3 — replay identity includes the source', () => {
  it('same plan, interval and source on an unexpired open purchase -> replay, COMMIT, no INSERT, no void', async () => {
    world({ sourcePlan: 'bronze', open: { plan: 'gold', interval: 'monthly', unexpired: true, replaces: SOURCE } });
    const result = await confirmPurchase(makePool() as any, input('gold', 'monthly'));
    expect(result).toEqual({ kind: 'replayed', purchaseId: 'old-purchase' });
    expect(sqls().some(isWrite)).toBe(false);
    expect(sqls()).toContain('COMMIT');
  });

  it('an open purchase for a DIFFERENT source (fixture) is not a replay: void + create', async () => {
    world({ sourcePlan: 'bronze', open: { plan: 'gold', interval: 'monthly', unexpired: true, replaces: OTHER } });
    voidChain();
    creation();
    const result = await confirmPurchase(makePool() as any, input('gold', 'monthly'));
    expect(result).toMatchObject({ kind: 'created', voided: { reason: 'superseded' } });
    expect(idx("UPDATE subscription_purchases SET status = 'void'")).toBeLessThan(idx('INSERT INTO subscriptions'));
  });

  it('a different TARGET at the same interval -> void (superseded) + create', async () => {
    world({ sourcePlan: 'bronze', open: { plan: 'silver', interval: 'monthly', unexpired: true, replaces: SOURCE } });
    voidChain();
    creation();
    const result = await confirmPurchase(makePool() as any, input('gold', 'monthly'));
    expect(result).toMatchObject({ kind: 'created', voided: { reason: 'superseded' } });
  });

  it('an EXPIRED open purchase -> void (expired_superseded) + create', async () => {
    world({ sourcePlan: 'bronze', open: { plan: 'gold', interval: 'monthly', unexpired: false, replaces: SOURCE } });
    voidChain();
    creation();
    const result = await confirmPurchase(makePool() as any, input('gold', 'monthly'));
    expect(result).toMatchObject({ kind: 'created', voided: { reason: 'expired_superseded' } });
  });

  // B8-R1 — the purchase expires while this request waits on the source lock.
  it('B8-R1: unexpired before the source lock, expired after it -> identical request does NOT replay; void (expired_superseded) + create', async () => {
    world({ sourcePlan: 'bronze', open: { plan: 'gold', interval: 'monthly', unexpired: true, unexpiredAfterSourceLock: false, replaces: SOURCE } });
    voidChain();
    creation();
    const result = await confirmPurchase(makePool() as any, input('gold', 'monthly'));
    expect(result).toMatchObject({ kind: 'created', voided: { reason: 'expired_superseded' } });
  });

  it('B8-R1: the authoritative expiry read happens after the source FOR UPDATE and before the replay/void decision', async () => {
    world({ sourcePlan: 'bronze', open: { plan: 'gold', interval: 'monthly', unexpired: true, replaces: SOURCE } });
    await confirmPurchase(makePool() as any, input('gold', 'monthly'));
    const source = idx('AND company_id = $2 FOR UPDATE');
    const clockReads = calls
      .map((c, i) => (c.sql.includes('clock_timestamp() < expires_at AS unexpired') ? i : -1))
      .filter((i) => i >= 0);
    expect(clockReads.length).toBe(2);
    expect(clockReads[0]).toBeLessThan(source); // lockOpenPurchase (informational only)
    expect(clockReads[1]).toBeGreaterThan(source); // authoritative
    expect(clockReads[1]).toBeGreaterThan(idx('AS has_unpaid'));
    expect(clockReads[1]).toBeLessThan(sqls().indexOf('COMMIT'));
    expect(calls[clockReads[1]].params).toEqual(['old-purchase']);
    // Database clock only.
    expect(calls[clockReads[1]].sql).not.toMatch(/now\(\)/);
  });

  it('a DIFFERENT INTERVAL with an open chain -> 409 and the open chain is NOT voided (no void SQL issued)', async () => {
    world({ sourcePlan: 'bronze', sourceInterval: 'monthly', open: { plan: 'gold', interval: 'monthly', unexpired: true, replaces: SOURCE } });
    await expectRejected(confirmPurchase(makePool() as any, input('gold', 'annual')), 'INTERVAL_CHANGE_NOT_SUPPORTED');
    expect(sqls().some((s) => s.includes("'void'"))).toBe(false);
  });
});

describe('T-API-4 — a missing assertion in upgrade mode', () => {
  it('-> 409 UPGRADE_CONTEXT_STALE after company -> purchase -> source locks, then ROLLBACK, zero writes', async () => {
    world();
    await expectRejected(confirmPurchase(makePool() as any, input('gold', 'monthly', null)), 'UPGRADE_CONTEXT_STALE');
    const company = idx('FROM companies WHERE id = $1 FOR UPDATE');
    const purchase = idx('FROM subscription_purchases sp');
    const source = idx('AND company_id = $2 FOR UPDATE');
    const rollback = sqls().indexOf('ROLLBACK');
    expect(company).toBeLessThan(purchase);
    expect(purchase).toBeLessThan(source);
    expect(source).toBeLessThan(rollback);
    // The context check precedes every rule read.
    expect(idx('AS has_unpaid')).toBe(-1);
  });
});

describe('T-API-5 — stale, unknown and cross-tenant ids are indistinguishable', () => {
  it('produce identical errors, and the supplied id never reaches any SQL parameter', async () => {
    const supplied = [OTHER, '33333333-3333-4333-8333-333333333333', SOURCE.replace('1111', '9999')];
    const errors: PurchaseError[] = [];
    for (const id of supplied) {
      calls = [];
      handlers = [];
      released = 0;
      world();
      const err = await confirmPurchase(makePool() as any, input('gold', 'monthly', id)).catch((e) => e);
      errors.push(err);
      for (const call of calls) {
        for (const p of call.params) expect(p).not.toBe(id);
        expect(call.sql).not.toContain(id);
      }
      expect(sqls().some(isWrite)).toBe(false);
    }
    const shape = (e: PurchaseError) => ({ status: e.status, code: e.code, message: e.message, extra: e.extra });
    expect(errors.every((e) => e instanceof PurchaseError)).toBe(true);
    expect(shape(errors[1])).toEqual(shape(errors[0]));
    expect(shape(errors[2])).toEqual(shape(errors[0]));
    expect(errors[0].code).toBe('UPGRADE_CONTEXT_STALE');
  });

  it('the comparison is case-insensitive for the matching id', async () => {
    world();
    creation();
    const result = await confirmPurchase(makePool() as any, input('gold', 'monthly', SOURCE.toUpperCase()));
    expect(result.kind).toBe('created');
  });
});
