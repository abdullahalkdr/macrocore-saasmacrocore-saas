import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Stage B7 — GET /api/billing/plans (design v3 §7 / §7.1).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  allowlisted: vi.fn(),
  getOpenPurchaseSummary: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: mocks.poolQuery } }));
vi.mock('../../utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn() }));
vi.mock('../admin.controller', () => ({
  isCompanyAllowlisted: mocks.allowlisted,
  buildCheckoutUrl: (id: string) => `https://sim.test/simulated-checkout#${id}.tok`,
}));
vi.mock('../../services/subscriptionPurchase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/subscriptionPurchase')>()),
  getOpenPurchaseSummary: mocks.getOpenPurchaseSummary,
}));

import { getPlans } from '../billing.controller';

const NOOP_NEXT = (() => {}) as any;
function makeRes(): Response & { statusCode?: number; body?: any } {
  const res: any = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
}
function makeReq(role = 'admin', headers: Record<string, string> = {}): Request {
  return { auth: { userId: 'user-1', companyId: 'company-1', role }, headers, params: {}, body: {} } as unknown as Request;
}
function companyRow(overrides: Record<string, unknown> = {}) {
  mocks.poolQuery.mockResolvedValueOnce({
    rows: [{ plan: 'trial', subscription_status: 'trial', trial_end_date: '2026-10-01T00:00:00.000Z', live_status: null, ...overrides }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.allowlisted.mockReturnValue(true);
  mocks.getOpenPurchaseSummary.mockResolvedValue(null);
  // Stage B8: follow-up upgrade-mode reads (live-row count, unpaid-invoice
  // check) for paid tenants; the first call is always the company row.
  mocks.poolQuery.mockResolvedValue({ rows: [{ n: 1, has_unpaid: false }] });
});

describe('GET /api/billing/plans', () => {
  it('returns the server catalogue with exact string prices, features, the 30-minute window and the current plan', async () => {
    companyRow();
    const res = makeRes();
    await getPlans(makeReq(), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body.currency).toBe('USD');
    expect(res.body.plans.find((p: any) => p.key === 'gold').prices).toEqual({ monthly: { amount: '67.00' }, annual: { amount: '660.00', monthly_equivalent: '55.00' } });
    expect(res.body.features.length).toBeGreaterThan(20);
    expect(res.body.checkout_window_minutes).toBe(30);
    expect(res.body.current).toMatchObject({ plan: 'trial', subscription_status: 'trial', live_subscription: null });
    expect(res.body).toMatchObject({ self_service_checkout_available: true, can_purchase: true, purchase_block_reason: null });
    // Scoped strictly to the caller's own company.
    expect(mocks.poolQuery.mock.calls[0][1]).toEqual(['company-1']);
  });

  it.each([
    ['a non-admin user', 'employee', {}, {}, 'NOT_ADMIN'],
    ['an API key', 'admin', { 'x-api-key': 'mk_live_x' }, {}, 'USER_SESSION_REQUIRED'],
    ['a paid tenant (live subscription)', 'admin', {}, { plan: 'gold', subscription_status: 'active', live_status: 'active', live_plan: 'gold', live_interval: 'annual' }, 'NOT_ELIGIBLE'],
    ['a suspended company', 'admin', {}, { subscription_status: 'suspended' }, 'NOT_ELIGIBLE'],
    ['a cancelled company', 'admin', {}, { subscription_status: 'cancelled' }, 'NOT_ELIGIBLE'],
  ])('%s cannot purchase (%s)', async (_label, role, headers, company, reason) => {
    companyRow(company);
    const res = makeRes();
    await getPlans(makeReq(role, headers as Record<string, string>), res, NOOP_NEXT);
    expect(res.body.can_purchase).toBe(false);
    expect(res.body.purchase_block_reason).toBe(reason);
  });

  it('checkout unavailable (simulator off / not allowlisted) -> CHECKOUT_UNAVAILABLE, still shows the catalogue', async () => {
    mocks.allowlisted.mockReturnValue(false);
    companyRow();
    const res = makeRes();
    await getPlans(makeReq(), res, NOOP_NEXT);
    expect(res.body).toMatchObject({ self_service_checkout_available: false, can_purchase: false, purchase_block_reason: 'CHECKOUT_UNAVAILABLE' });
    expect(res.body.plans).toHaveLength(4);
  });

  it('exposes the open purchase only to a signed-in admin (never to employees or API keys)', async () => {
    mocks.getOpenPurchaseSummary.mockResolvedValue({ id: 'p-1', status: 'open' });
    companyRow();
    let res = makeRes();
    await getPlans(makeReq(), res, NOOP_NEXT);
    expect(res.body.open_purchase).toEqual({ id: 'p-1', status: 'open' });

    companyRow();
    res = makeRes();
    await getPlans(makeReq('employee'), res, NOOP_NEXT);
    expect(res.body.open_purchase).toBeNull();

    companyRow();
    res = makeRes();
    await getPlans(makeReq('admin', { 'x-api-key': 'k' }), res, NOOP_NEXT);
    expect(res.body.open_purchase).toBeNull();
    expect(mocks.getOpenPurchaseSummary).toHaveBeenCalledTimes(1);
  });

  it('404 when the company does not exist', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getPlans(makeReq(), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// Stage B8 — the upgrade object (design v4 §6.1; test T-API-10). The legacy
// can_purchase / purchase_block_reason keep their exact B7 meaning.
// ---------------------------------------------------------------------------
describe('GET /api/billing/plans — Stage B8 upgrade object', () => {
  const SOURCE = '11111111-1111-4111-8111-111111111111';
  function paid(plan: string, interval = 'monthly', overrides: Record<string, unknown> = {}) {
    companyRow({ plan, subscription_status: 'active', live_id: SOURCE, live_status: 'active', live_plan: plan, live_interval: interval, ...overrides });
  }

  it('legacy fields for a paid tenant stay exactly B7 (can_purchase false, NOT_ELIGIBLE)', async () => {
    paid('bronze');
    const res = makeRes();
    await getPlans(makeReq(), res, NOOP_NEXT);
    expect(res.body).toMatchObject({ can_purchase: false, purchase_block_reason: 'NOT_ELIGIBLE' });
  });

  it.each([
    ['bronze', 'monthly', ['silver', 'gold']],
    ['bronze', 'annual', ['silver', 'gold']],
    ['silver', 'annual', ['gold']],
  ])('a %s/%s JWT admin gets targets %j at the SOURCE interval, and the source id', async (plan, interval, targets) => {
    paid(plan, interval);
    const res = makeRes();
    await getPlans(makeReq(), res, NOOP_NEXT);
    expect(res.body.upgrade).toEqual({ available: true, block_reason: null, source_subscription_id: SOURCE, interval, targets });
    expect(res.body.current.live_subscription.id).toBe(SOURCE);
  });

  it('a gold source -> NO_UPGRADE_AVAILABLE with no targets', async () => {
    paid('gold', 'annual');
    const res = makeRes();
    await getPlans(makeReq(), res, NOOP_NEXT);
    expect(res.body.upgrade).toMatchObject({ available: false, block_reason: 'NO_UPGRADE_AVAILABLE', targets: [] });
  });

  it('an enterprise source, or companies.plan out of step with the live row -> NOT_ELIGIBLE', async () => {
    paid('enterprise', 'annual');
    let res = makeRes();
    await getPlans(makeReq(), res, NOOP_NEXT);
    expect(res.body.upgrade).toMatchObject({ available: false, block_reason: 'NOT_ELIGIBLE', targets: [] });
    paid('bronze', 'monthly', { plan: 'silver' });
    res = makeRes();
    await getPlans(makeReq(), res, NOOP_NEXT);
    expect(res.body.upgrade).toMatchObject({ available: false, block_reason: 'NOT_ELIGIBLE' });
  });

  it('an unpaid issued source invoice -> UNPAID_INVOICE (checked on the live subscription id)', async () => {
    paid('bronze');
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ n: 1 }] }).mockResolvedValueOnce({ rows: [{ has_unpaid: true }] });
    const res = makeRes();
    await getPlans(makeReq(), res, NOOP_NEXT);
    expect(res.body.upgrade).toMatchObject({ available: false, block_reason: 'UNPAID_INVOICE' });
    expect(mocks.poolQuery.mock.calls[2][1]).toEqual([SOURCE]);
  });

  it('simulator unavailable -> CHECKOUT_UNAVAILABLE', async () => {
    mocks.allowlisted.mockReturnValue(false);
    paid('bronze');
    const res = makeRes();
    await getPlans(makeReq(), res, NOOP_NEXT);
    expect(res.body.upgrade).toMatchObject({ available: false, block_reason: 'CHECKOUT_UNAVAILABLE' });
  });

  it('a non-admin user and an API key never see the source id', async () => {
    paid('bronze');
    let res = makeRes();
    await getPlans(makeReq('employee'), res, NOOP_NEXT);
    expect(res.body.upgrade).toMatchObject({ available: false, block_reason: 'NOT_ADMIN', source_subscription_id: null });
    expect(res.body.current.live_subscription.id).toBeNull();
    paid('bronze');
    res = makeRes();
    await getPlans(makeReq('admin', { 'x-api-key': 'k' }), res, NOOP_NEXT);
    expect(res.body.upgrade).toMatchObject({ available: false, block_reason: 'USER_SESSION_REQUIRED', source_subscription_id: null });
    expect(res.body.current.live_subscription.id).toBeNull();
  });

  it('no upgrade object for trial, suspended, cancelled, past_due or multi-live companies', async () => {
    for (const row of [
      {},
      { subscription_status: 'suspended' },
      { subscription_status: 'cancelled' },
      { plan: 'bronze', subscription_status: 'active', live_id: SOURCE, live_status: 'past_due', live_plan: 'bronze', live_interval: 'monthly' },
    ]) {
      companyRow(row);
      const res = makeRes();
      await getPlans(makeReq(), res, NOOP_NEXT);
      expect(res.body.upgrade).toBeNull();
    }
    paid('bronze');
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ n: 2 }] });
    const res = makeRes();
    await getPlans(makeReq(), res, NOOP_NEXT);
    expect(res.body.upgrade).toBeNull();
  });
});
