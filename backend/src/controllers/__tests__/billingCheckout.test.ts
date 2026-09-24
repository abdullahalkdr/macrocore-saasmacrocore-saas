import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Stage B7 — POST /api/billing/purchases/:id/checkout (design v3 §9.3).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  allowlisted: vi.fn(),
  startCheckout: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../../utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('../../utils/audit', () => ({ logAudit: mocks.logAudit }));
vi.mock('../admin.controller', () => ({
  isCompanyAllowlisted: mocks.allowlisted,
  buildCheckoutUrl: (id: string) => `https://sim.test/simulated-checkout#${id}.tok`,
}));
vi.mock('../../services/subscriptionPurchase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/subscriptionPurchase')>()),
  startCheckout: mocks.startCheckout,
}));

import { startPurchaseCheckout } from '../billing.controller';
import { PurchaseError } from '../../services/subscriptionPurchase';

const NOOP_NEXT = (() => {}) as any;
const PID = '11111111-2222-3333-4444-555555555555';
function makeRes(): Response & { statusCode?: number; body?: any } {
  const res: any = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
}
function makeReq(body: unknown = {}, id = PID): Request {
  return { auth: { userId: 'user-1', companyId: 'company-1', role: 'admin' }, headers: {}, params: { id }, body, ip: '10.0.0.1' } as unknown as Request;
}
const RESULT = { purchaseId: PID, companyId: 'company-1', invoiceId: 'i-1', attemptId: 'a-1', sessionId: 's-1', attemptCreated: true, sessionCreated: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.allowlisted.mockReturnValue(true);
  mocks.startCheckout.mockResolvedValue(RESULT);
  mocks.logAudit.mockResolvedValue(undefined);
});

describe('POST /api/billing/purchases/:id/checkout', () => {
  it('returns the hosted checkout URL for the tenant-scoped purchase and audits a newly created attempt/session', async () => {
    const res = makeRes();
    await startPurchaseCheckout(makeReq(), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, purchase_id: PID, checkout_url: 'https://sim.test/simulated-checkout#s-1.tok' });
    expect(mocks.startCheckout).toHaveBeenCalledWith(expect.anything(), 'company-1', PID);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit.mock.calls[0][0]).toMatchObject({ action: 'subscription_checkout_started', userId: 'user-1', entityId: 's-1' });
    expect(JSON.stringify(mocks.logAudit.mock.calls[0][0])).not.toMatch(/checkout_url|#|tok/);
  });

  it('a reused session (refresh / double click) returns the same URL and writes no audit', async () => {
    mocks.startCheckout.mockResolvedValue({ ...RESULT, attemptCreated: false, sessionCreated: false });
    const res = makeRes();
    await startPurchaseCheckout(makeReq(), res, NOOP_NEXT);
    expect(res.body.checkout_url).toBe('https://sim.test/simulated-checkout#s-1.tok');
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('accepts an empty body or {} but rejects any field with 400 UNKNOWN_FIELD', async () => {
    let res = makeRes();
    await startPurchaseCheckout(makeReq(undefined), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    res = makeRes();
    await startPurchaseCheckout(makeReq({ amount: '1.00' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'UNKNOWN_FIELD', fields: ['amount'] });
    expect(mocks.startCheckout).toHaveBeenCalledTimes(1);
  });

  it('checkout unavailable -> 409 CHECKOUT_UNAVAILABLE without touching the service', async () => {
    mocks.allowlisted.mockReturnValue(false);
    const res = makeRes();
    await startPurchaseCheckout(makeReq(), res, NOOP_NEXT);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('CHECKOUT_UNAVAILABLE');
    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'PURCHASE_EXPIRED'],
    [409, 'PURCHASE_CLOSED'],
    [404, 'NOT_FOUND'],
  ])('maps service %s %s through unchanged', async (status, code) => {
    mocks.startCheckout.mockRejectedValue(new PurchaseError(status, code, 'msg'));
    const res = makeRes();
    await startPurchaseCheckout(makeReq(), res, NOOP_NEXT);
    expect(res.statusCode).toBe(status);
    expect(res.body).toMatchObject({ success: false, code });
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('a non-UUID id -> 404 without calling the service', async () => {
    await expect(startPurchaseCheckout(makeReq({}, 'abc'), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });
});
