import { beforeEach, describe, expect, it } from 'vitest';
import { applyPurchaseOnTrustedSuccess, LockedPurchaseChain } from '../subscriptionPurchase';

// ---------------------------------------------------------------------------
// Stage B8 — applyUpgradeOnTrustedSuccess via applyPurchaseOnTrustedSuccess
// (design v4 §8.4; test T-SVC-1). A scripted fake client records every
// statement so the write ORDER is asserted exactly — in particular that the
// source leaves 'active' BEFORE the pending row enters it (the non-deferrable
// subscriptions_one_live_per_company index), and that no clock/expiry read
// happens here.
// ---------------------------------------------------------------------------

let calls: { sql: string; params: unknown[] }[];
let responses: [string, { rows: any[] }][];

function on(match: string, rows: any[]) {
  responses.push([match, { rows }]);
}
const client = {
  query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const [m, r] of responses) if (sql.includes(m)) return r;
    throw new Error(`unexpected query: ${sql}`);
  },
};
const sqls = () => calls.map((c) => c.sql);
const idx = (needle: string) => calls.findIndex((c) => c.sql.includes(needle));

const LOCKED: LockedPurchaseChain = {
  company: { id: 'company-1', plan: 'bronze', subscription_status: 'active' },
  purchase: { id: 'purchase-1', status: 'open', subscription_id: 'pending-1', invoice_id: 'inv-1', replaces_subscription_id: 'source-1' },
  source: { id: 'source-1', company_id: 'company-1', plan: 'bronze', status: 'active', billing_interval: 'monthly' },
  pendingSub: { id: 'pending-1', status: 'pending_payment', plan: 'gold', billing_interval: 'monthly' },
  attempt: { id: 'attempt-1' },
  session: { id: 'session-1' },
  invoice: { id: 'inv-1' },
};

function happy(opts: { otherLive?: boolean; supersedeRows?: any[]; activateRows?: any[]; companyRows?: any[]; completeRows?: any[] } = {}) {
  on('AS has_other', [{ has_other: opts.otherLive ?? false }]);
  on('UPDATE payment_attempts SET status', [{ id: 'attempt-1', status: 'succeeded', succeeded_at: '2026-09-24T09:00:00Z' }]);
  on('UPDATE payment_checkout_sessions SET status', [{ id: 'session-1', status: 'succeeded', resolved_at: '2026-09-24T09:00:00Z' }]);
  on("UPDATE invoices SET status = 'paid'", [{ id: 'inv-1', status: 'paid', payment_date: '2026-09-24T09:00:00Z' }]);
  on("UPDATE subscriptions SET status = 'superseded'", opts.supersedeRows ?? [{ id: 'source-1' }]);
  on("UPDATE subscriptions SET status = 'active'", opts.activateRows ?? [
    { id: 'pending-1', plan: 'gold', billing_interval: 'monthly', current_period_start: '2026-09-24T08:40:00Z', current_period_end: '2026-10-24T08:40:00Z' },
  ]);
  on('UPDATE companies SET plan', opts.companyRows ?? [{ id: 'company-1' }]);
  on("UPDATE subscription_purchases SET status = 'completed'", opts.completeRows ?? [{ completed_at: '2026-09-24T09:00:01Z' }]);
}

beforeEach(() => {
  calls = [];
  responses = [];
});

describe('applyUpgradeOnTrustedSuccess (T-SVC-1)', () => {
  it('writes in the approved order: settle -> source superseded -> pending active -> company plan -> purchase completed', async () => {
    happy();
    const { applied, settle } = await applyPurchaseOnTrustedSuccess(client as any, LOCKED);
    const order = [
      idx('UPDATE payment_attempts'),
      idx('UPDATE payment_checkout_sessions'),
      idx("UPDATE invoices SET status = 'paid'"),
      idx("UPDATE subscriptions SET status = 'superseded'"),
      idx("UPDATE subscriptions SET status = 'active'"),
      idx('UPDATE companies SET plan'),
      idx("UPDATE subscription_purchases SET status = 'completed'"),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(settle.invoiceNewStatus).toBe('paid');
    expect(applied).toMatchObject({
      purchase_id: 'purchase-1',
      subscription_id: 'pending-1',
      superseded_subscription_id: 'source-1',
      old_values: { plan: 'bronze', subscription_status: 'active' },
      new_values: { plan: 'gold', subscription_status: 'active' },
      billing_interval: 'monthly',
    });
  });

  it('targets the exact rows: the source id for superseded, the pending id for active, the company for the plan', async () => {
    happy();
    await applyPurchaseOnTrustedSuccess(client as any, LOCKED);
    expect(calls[idx("UPDATE subscriptions SET status = 'superseded'")]).toMatchObject({ params: ['source-1'] });
    expect(calls[idx("UPDATE subscriptions SET status = 'superseded'")].sql).toContain("AND status = 'active'");
    expect(calls[idx("UPDATE subscriptions SET status = 'active'")].params).toEqual(['pending-1']);
    const company = calls[idx('UPDATE companies SET plan')];
    expect(company.params).toEqual(['gold', 'company-1']);
    expect(company.sql).toContain("subscription_status = 'active'");
    // subscription_status is not rewritten for an upgrade.
    expect(company.sql).not.toMatch(/SET plan = \$1, subscription_status/);
  });

  it('DELAYED-CALLBACK PROOF: no clock or expiry read (payment_date = clock_timestamp() is a write)', async () => {
    happy();
    await applyPurchaseOnTrustedSuccess(client as any, LOCKED);
    expect(
      sqls()
        .filter((s) => !/payment_date = clock_timestamp\(\)/.test(s))
        .some((s) => /clock_timestamp|expires_at|now\(\)/.test(s))
    ).toBe(false);
  });

  it('never cancels trial-lifecycle emails and never enqueues anything', async () => {
    happy();
    await applyPurchaseOnTrustedSuccess(client as any, LOCKED);
    expect(sqls().some((s) => s.includes('email_jobs'))).toBe(false);
  });

  const broken: [string, Partial<LockedPurchaseChain> | ((l: LockedPurchaseChain) => LockedPurchaseChain)][] = [
    ['purchase not open', { purchase: { ...LOCKED.purchase, status: 'void' } }],
    ['pending not pending_payment', { pendingSub: { ...LOCKED.pendingSub, status: 'abandoned' } }],
    ['source not locked', { source: null }],
    ['source id differs from the purchase link', { source: { ...LOCKED.source!, id: 'other' } }],
    ['source not active', { source: { ...LOCKED.source!, status: 'superseded' } }],
    ['source in another company', { source: { ...LOCKED.source!, company_id: 'company-2' } }],
    ['company not active', { company: { ...LOCKED.company, subscription_status: 'suspended' } }],
    ['company plan out of step', { company: { ...LOCKED.company, plan: 'silver' } }],
    ['target not higher', { pendingSub: { ...LOCKED.pendingSub, plan: 'bronze' } }],
    ['interval mismatch', { pendingSub: { ...LOCKED.pendingSub, billing_interval: 'annual' } }],
  ];
  it.each(broken)('integrity violation (%s) throws before any write', async (_label, patch) => {
    happy();
    const locked = typeof patch === 'function' ? patch(LOCKED) : { ...LOCKED, ...patch };
    await expect(applyPurchaseOnTrustedSuccess(client as any, locked as LockedPurchaseChain)).rejects.toThrow(/applyUpgradeOnTrustedSuccess/);
    expect(sqls().some((s) => /^\s*UPDATE/.test(s))).toBe(false);
  });

  it('another live row for the company throws before any write', async () => {
    happy({ otherLive: true });
    await expect(applyPurchaseOnTrustedSuccess(client as any, LOCKED)).rejects.toThrow(/another live subscription/);
    expect(sqls().some((s) => /^\s*UPDATE/.test(s))).toBe(false);
  });

  it.each([
    ['source supersede', { supersedeRows: [] }],
    ['pending activation', { activateRows: [] }],
    ['company plan', { companyRows: [] }],
    ['purchase completion', { completeRows: [] }],
  ])('a rowcount other than 1 on the %s update throws', async (_label, opts) => {
    happy(opts);
    await expect(applyPurchaseOnTrustedSuccess(client as any, LOCKED)).rejects.toThrow(/expected exactly one row/);
  });

  it('a B7 purchase (replaces_subscription_id NULL) still takes the unchanged trial apply path', async () => {
    on('AS has_live', [{ has_live: false }]);
    happy();
    on('UPDATE email_jobs', []);
    const trialLocked: LockedPurchaseChain = {
      ...LOCKED,
      company: { id: 'company-1', plan: 'trial', subscription_status: 'trial' },
      purchase: { ...LOCKED.purchase, replaces_subscription_id: null },
      source: null,
    };
    const { applied } = await applyPurchaseOnTrustedSuccess(client as any, trialLocked);
    expect(applied.superseded_subscription_id).toBeUndefined();
    expect(sqls().some((s) => s.includes("'superseded'"))).toBe(false);
    expect(sqls().some((s) => s.includes('UPDATE email_jobs'))).toBe(true);
  });
});
