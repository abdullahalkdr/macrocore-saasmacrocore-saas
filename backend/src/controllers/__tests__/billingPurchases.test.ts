import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Stage B7 — POST /api/billing/purchases and GET /api/billing/purchases/:id
// (design v3 §7, §9.2). Authentication/role/API-key rejection is proven in
// routes/__tests__/billingRoutes.test.ts against the real middleware chain.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  allowlisted: vi.fn(),
  confirmPurchase: vi.fn(),
  getPurchaseSummary: vi.fn(),
  logAudit: vi.fn(),
  enqueueEmail: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../../utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('../../utils/audit', () => ({ logAudit: mocks.logAudit }));
vi.mock('../../utils/email', () => ({ enqueueEmail: mocks.enqueueEmail }));
vi.mock('../admin.controller', () => ({
  isCompanyAllowlisted: mocks.allowlisted,
  buildCheckoutUrl: (id: string) => `https://sim.test/simulated-checkout#${id}.tok`,
}));
vi.mock('../../services/subscriptionPurchase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/subscriptionPurchase')>()),
  confirmPurchase: mocks.confirmPurchase,
  getPurchaseSummary: mocks.getPurchaseSummary,
}));

import { createPurchase, getPurchase } from '../billing.controller';
import { PurchaseError } from '../../services/subscriptionPurchase';

const NOOP_NEXT = (() => {}) as any;
function makeRes(): Response & { statusCode?: number; body?: any } {
  const res: any = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
}
function makeReq(body: unknown, params: Record<string, string> = {}): Request {
  return { auth: { userId: 'user-1', companyId: 'company-1', role: 'admin' }, headers: {}, params, body, ip: '10.0.0.1' } as unknown as Request;
}
const SUMMARY = { id: 'p-1', status: 'open', plan: 'silver', billing_interval: 'annual', currency: 'USD', amount: '384.00', expires_at: '2026-09-24T10:30:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.allowlisted.mockReturnValue(true);
  mocks.getPurchaseSummary.mockResolvedValue(SUMMARY);
  mocks.logAudit.mockResolvedValue(undefined);
});

describe('POST /api/billing/purchases — strict body validation', () => {
  it.each(['amount', 'currency', 'company_id', 'subscription_id', 'invoice_id', 'price', 'period_start'])(
    'rejects the authoritative/unknown field "%s" with 400 UNKNOWN_FIELD (never silently ignored)',
    async (field) => {
      const res = makeRes();
      await createPurchase(makeReq({ plan: 'silver', billing_interval: 'annual', [field]: 1 }), res, NOOP_NEXT);
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'UNKNOWN_FIELD', fields: [field] });
      expect(mocks.confirmPurchase).not.toHaveBeenCalled();
    }
  );

  it('rejects a non-object body', async () => {
    await expect(createPurchase(makeReq(['silver']), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
    await expect(createPurchase(makeReq(null), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('enterprise -> 400 PLAN_NOT_SELF_SERVICE; unknown plan/interval -> 400', async () => {
    await expect(createPurchase(makeReq({ plan: 'enterprise', billing_interval: 'annual' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400, code: 'PLAN_NOT_SELF_SERVICE' });
    await expect(createPurchase(makeReq({ plan: 'platinum', billing_interval: 'annual' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
    await expect(createPurchase(makeReq({ plan: 'gold', billing_interval: 'weekly' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
    await expect(createPurchase(makeReq({ billing_interval: 'monthly' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.confirmPurchase).not.toHaveBeenCalled();
  });
});

describe('POST /api/billing/purchases — behaviour', () => {
  it.each([
    ['bronze', 'monthly', '32.00'],
    ['silver', 'annual', '384.00'],
    ['gold', 'annual', '660.00'],
  ])('%s/%s passes the server catalogue STRING %s and company from the token', async (plan, interval, amount) => {
    mocks.confirmPurchase.mockResolvedValue({ kind: 'created', purchaseId: 'p-1', invoiceId: 'i-1', invoiceNumber: 'MC-SUB-000011', subscriptionId: 's-1', voided: null });
    const res = makeRes();
    await createPurchase(makeReq({ plan, billing_interval: interval }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(201);
    expect(mocks.confirmPurchase).toHaveBeenCalledWith(expect.anything(), {
      companyId: 'company-1', plan, interval, currency: 'USD', amountText: amount,
    });
    expect(typeof mocks.confirmPurchase.mock.calls[0][1].amountText).toBe('string');
  });

  it('checkout unavailable -> 409 CHECKOUT_UNAVAILABLE with zero service calls (non-allowlisted tenants never create billing rows)', async () => {
    mocks.allowlisted.mockReturnValue(false);
    const res = makeRes();
    await createPurchase(makeReq({ plan: 'silver', billing_interval: 'annual' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('CHECKOUT_UNAVAILABLE');
    expect(mocks.confirmPurchase).not.toHaveBeenCalled();
  });

  it('maps a service NOT_ELIGIBLE to 409 with its code', async () => {
    mocks.confirmPurchase.mockRejectedValue(new PurchaseError(409, 'NOT_ELIGIBLE', 'nope'));
    const res = makeRes();
    await createPurchase(makeReq({ plan: 'silver', billing_interval: 'annual' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'nope', code: 'NOT_ELIGIBLE' });
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('a replay returns 200 with the same purchase and writes no audit', async () => {
    mocks.confirmPurchase.mockResolvedValue({ kind: 'replayed', purchaseId: 'p-1' });
    const res = makeRes();
    await createPurchase(makeReq({ plan: 'silver', billing_interval: 'annual' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, purchase: SUMMARY });
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('a creation that superseded an old intent audits the void first, then the creation — post-commit, no URL/key, no email', async () => {
    mocks.confirmPurchase.mockResolvedValue({
      kind: 'created', purchaseId: 'p-2', invoiceId: 'i-2', invoiceNumber: 'MC-SUB-000012', subscriptionId: 's-2',
      voided: { purchase_id: 'p-1', reason: 'superseded', invoice_id: 'i-1', invoice_number: 'MC-SUB-000011', subscription_id: 's-1', company_id: 'company-1', cancelled_payment_attempt_ids: [] },
    });
    const res = makeRes();
    await createPurchase(makeReq({ plan: 'gold', billing_interval: 'monthly' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(201);
    expect(mocks.logAudit.mock.calls.map((c) => c[0].action)).toEqual(['subscription_purchase_voided', 'subscription_purchase_created']);
    const created = mocks.logAudit.mock.calls[1][0];
    expect(created).toMatchObject({ userId: 'user-1', entityId: 'p-2', newValues: { invoice_number: 'MC-SUB-000012', amount: '384.00' } });
    expect(JSON.stringify(mocks.logAudit.mock.calls)).not.toMatch(/checkout_url|simulated-checkout#|idempotency/);
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });

  it('an audit failure never changes the committed 201', async () => {
    mocks.confirmPurchase.mockResolvedValue({ kind: 'created', purchaseId: 'p-1', invoiceId: 'i-1', invoiceNumber: 'N', subscriptionId: 's-1', voided: null });
    mocks.logAudit.mockRejectedValue(new Error('audit down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();
    await createPurchase(makeReq({ plan: 'silver', billing_interval: 'annual' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(201);
  });
});

describe('GET /api/billing/purchases/:id', () => {
  it('returns the tenant-scoped summary', async () => {
    const res = makeRes();
    await getPurchase(makeReq({}, { id: '11111111-2222-3333-4444-555555555555' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(mocks.getPurchaseSummary).toHaveBeenCalledWith(expect.anything(), 'company-1', '11111111-2222-3333-4444-555555555555');
  });

  it("another tenant's (or unknown) id -> 404", async () => {
    mocks.getPurchaseSummary.mockResolvedValue(null);
    await expect(getPurchase(makeReq({}, { id: '11111111-2222-3333-4444-555555555555' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a non-UUID id -> 404 without any query', async () => {
    await expect(getPurchase(makeReq({}, { id: 'not-a-uuid' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.getPurchaseSummary).not.toHaveBeenCalled();
  });
});
