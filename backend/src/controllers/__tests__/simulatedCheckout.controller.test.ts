import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Stage B6 — the hosted checkout page's two JSON endpoints
// (simulatedCheckout.controller.ts). Uses the REAL
// signSessionToken/verifySessionToken/parseBearerSessionToken
// (utils/paymentSimulatorToken.ts) rather than mocking them, so the tests
// exercise the actual HMAC signature check, not a stand-in for it.
// config/env is mocked with getters backed by mutable state (same pattern
// as adminCheckoutSession.test.ts) so PAYMENT_SIMULATOR_OPERATIONAL and the
// allowlist can vary per test. resolveCheckoutSessionCore/
// buildAuditPayloadForResolve are mocked — their own behavior is covered by
// paymentSettlement.test.ts.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  logAudit: vi.fn(),
  resolveCheckoutSessionCore: vi.fn(),
  buildAuditPayloadForResolve: vi.fn(),
  buildAuditPayloadForPurchaseApplied: vi.fn(),
}));

const TOKEN_SECRET = 'unit-test-simulator-secret-32-bytes-min';

const envState = vi.hoisted(() => ({
  operational: true,
  companyIds: ['company-allowed'],
}));

vi.mock('../../db/pool', () => ({
  pool: { query: mocks.poolQuery },
}));
vi.mock('../../utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('../../utils/audit', () => ({ logAudit: mocks.logAudit }));
vi.mock('../../config/env', () => ({
  env: {
    get PAYMENT_SIMULATOR_COMPANY_IDS() {
      return envState.companyIds;
    },
    PAYMENT_SIMULATOR_TOKEN_SECRET: 'unit-test-simulator-secret-32-bytes-min',
    // Stage B7 — origin the hosted page links back to (return_url).
    FRONTEND_URL: 'https://app.macrocore.test',
  },
  get PAYMENT_SIMULATOR_OPERATIONAL() {
    return envState.operational;
  },
}));
vi.mock('../../services/paymentSettlement', () => ({
  resolveCheckoutSessionCore: mocks.resolveCheckoutSessionCore,
  buildAuditPayloadForResolve: mocks.buildAuditPayloadForResolve,
  buildAuditPayloadForPurchaseApplied: mocks.buildAuditPayloadForPurchaseApplied,
}));

import { getHostedCheckoutSession, resolveHostedCheckoutSession } from '../simulatedCheckout.controller';
import { signSessionToken } from '../../utils/paymentSimulatorToken';

const NOOP_NEXT = (() => {}) as any;
const SESSION_ID = 'session-1';

function bearerFor(sessionId: string, secret: string = TOKEN_SECRET): string {
  return `Bearer ${sessionId}.${signSessionToken(sessionId, secret)}`;
}

function makeRes(): Response & { statusCode?: number; body?: any } {
  const res: any = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
}

function makeReq(authorization: string | undefined, body: Record<string, unknown> = {}): Request {
  return {
    headers: authorization !== undefined ? { authorization } : {},
    body,
    ip: '10.0.0.1',
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  envState.operational = true;
  envState.companyIds = ['company-allowed'];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getHostedCheckoutSession — shared auth chain', () => {
  it('returns 401 when the Authorization header is absent', async () => {
    const req = makeReq(undefined);
    const res = makeRes();

    await getHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('returns 401 when the Authorization header is malformed (no dot separator)', async () => {
    const req = makeReq('Bearer sometokenwithnodot');
    const res = makeRes();

    await getHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(401);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('returns 404 (not 401) when the simulator is globally disabled, without any DB query', async () => {
    envState.operational = false;
    const req = makeReq(bearerFor(SESSION_ID));
    const res = makeRes();

    await getHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(404);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('returns 404 when the presented token does not match the HMAC of the sessionId, without any DB query', async () => {
    const req = makeReq(bearerFor(SESSION_ID, 'a-completely-different-secret-32-bytes'));
    const res = makeRes();

    await getHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(404);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('returns 404 when the routing lookup finds no matching session row', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = makeReq(bearerFor(SESSION_ID));
    const res = makeRes();

    await getHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the session exists but its company was removed from the allowlist', async () => {
    envState.companyIds = ['someone-else'];
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-not-allowed' }] });
    const req = makeReq(bearerFor(SESSION_ID));
    const res = makeRes();

    await getHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(404);
  });
});

describe('getHostedCheckoutSession — happy path', () => {
  it('returns 200 with the session + payment_attempt shape once auth passes', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: SESSION_ID,
          status: 'pending',
          resolved_at: null,
          amount: '660.000',
          currency: 'USD',
          plan: 'gold',
          billing_interval: 'annual',
        },
      ],
    });
    const req = makeReq(bearerFor(SESSION_ID));
    const res = makeRes();

    await getHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      session: { id: SESSION_ID, status: 'pending', resolved_at: null },
      payment_attempt: { amount: '660.000', currency: 'USD', plan: 'gold', billing_interval: 'annual' },
      // Stage B7 additions: advisory can_succeed (row lacked it -> false)
      // and no return link for a session that is not a self-service purchase.
      can_succeed: false,
      return_url: null,
    });
  });

  it('returns 404 if the session vanished between the auth check and the data read', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = makeReq(bearerFor(SESSION_ID));
    const res = makeRes();

    await getHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(404);
  });
});

describe('resolveHostedCheckoutSession', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const req = makeReq(undefined, { outcome: 'succeeded' });
    const res = makeRes();

    await resolveHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(401);
    expect(mocks.resolveCheckoutSessionCore).not.toHaveBeenCalled();
  });

  it('returns 404 when the simulator is globally disabled', async () => {
    envState.operational = false;
    const req = makeReq(bearerFor(SESSION_ID), { outcome: 'succeeded' });
    const res = makeRes();

    await resolveHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(404);
    expect(mocks.resolveCheckoutSessionCore).not.toHaveBeenCalled();
  });

  it('returns 404 on a bad signature', async () => {
    const req = makeReq(bearerFor(SESSION_ID, 'wrong-secret-that-is-also-32-bytes-min'), { outcome: 'succeeded' });
    const res = makeRes();

    await resolveHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(404);
    expect(mocks.resolveCheckoutSessionCore).not.toHaveBeenCalled();
  });

  it('returns 404 when the company was removed from the allowlist', async () => {
    envState.companyIds = ['someone-else'];
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-not-allowed' }] });
    const req = makeReq(bearerFor(SESSION_ID), { outcome: 'succeeded' });
    const res = makeRes();

    await resolveHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(404);
    expect(mocks.resolveCheckoutSessionCore).not.toHaveBeenCalled();
  });

  it('rejects an invalid outcome with 400 AFTER auth has already passed', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    const req = makeReq(bearerFor(SESSION_ID), { outcome: 'refunded' });
    const res = makeRes();

    await expect(resolveHostedCheckoutSession(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.resolveCheckoutSessionCore).not.toHaveBeenCalled();
  });

  it('returns 404 when the settlement core reports not_found', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.resolveCheckoutSessionCore.mockResolvedValueOnce({ kind: 'not_found' });
    const req = makeReq(bearerFor(SESSION_ID), { outcome: 'succeeded' });
    const res = makeRes();

    await resolveHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false });
  });

  it('returns 409 with the core-provided message on a conflict', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.resolveCheckoutSessionCore.mockResolvedValueOnce({ kind: 'conflict', message: 'already resolved' });
    const req = makeReq(bearerFor(SESSION_ID), { outcome: 'succeeded' });
    const res = makeRes();

    await resolveHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'already resolved' });
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('returns 200 and audits post-commit with resolvedVia=simulated_hosted_page and the authenticated companyId', async () => {
    const okResult = {
      kind: 'ok' as const,
      result: {
        attemptId: 'attempt-1',
        attemptNewStatus: 'succeeded' as const,
        attemptResolvedAt: '2026-09-17T12:00:00.000Z',
        sessionId: SESSION_ID,
        sessionExisted: true,
        sessionResolvedAt: '2026-09-17T12:00:00.000Z',
        invoiceId: 'invoice-1',
        invoiceNewStatus: 'paid' as const,
        invoicePaymentDate: '2026-09-17T12:00:00.000Z',
      },
      session: { id: SESSION_ID, status: 'succeeded' as const, resolved_at: '2026-09-17T12:00:00.000Z' },
    };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.resolveCheckoutSessionCore.mockResolvedValueOnce(okResult);
    mocks.buildAuditPayloadForResolve.mockReturnValueOnce({
      action: 'payment_checkout_session_resolved',
      entityType: 'payment_checkout_sessions',
      entityId: SESSION_ID,
    });

    const req = makeReq(bearerFor(SESSION_ID), { outcome: 'succeeded' });
    const res = makeRes();

    await resolveHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      session: { id: SESSION_ID, status: 'succeeded', resolved_at: '2026-09-17T12:00:00.000Z' },
    });
    expect(mocks.resolveCheckoutSessionCore).toHaveBeenCalledWith(expect.anything(), SESSION_ID, 'succeeded');
    expect(mocks.buildAuditPayloadForResolve).toHaveBeenCalledWith(okResult.result, 'simulated_hosted_page');
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit.mock.calls[0][0].companyId).toBe('company-allowed');
  });

  it('still returns 200 even if the best-effort audit call rejects', async () => {
    const okResult = {
      kind: 'ok' as const,
      result: {
        attemptId: 'attempt-1',
        attemptNewStatus: 'cancelled' as const,
        attemptResolvedAt: '2026-09-17T12:00:00.000Z',
        sessionId: SESSION_ID,
        sessionExisted: true,
        sessionResolvedAt: '2026-09-17T12:00:00.000Z',
        invoiceId: null,
        invoiceNewStatus: null,
        invoicePaymentDate: null,
      },
      session: { id: SESSION_ID, status: 'cancelled' as const, resolved_at: '2026-09-17T12:00:00.000Z' },
    };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.resolveCheckoutSessionCore.mockResolvedValueOnce(okResult);
    mocks.buildAuditPayloadForResolve.mockReturnValueOnce({});
    mocks.logAudit.mockRejectedValueOnce(new Error('audit sink unavailable'));

    const req = makeReq(bearerFor(SESSION_ID), { outcome: 'cancelled' });
    const res = makeRes();

    await resolveHostedCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Stage B7 — purchase-linked sessions on the hosted page.
// ---------------------------------------------------------------------------

describe('getHostedCheckoutSession — Stage B7 purchase fields', () => {
  it('returns can_succeed (advisory, SQL clock_timestamp()) and a server-built return_url for a purchase session', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [{
        id: SESSION_ID, status: 'pending', resolved_at: null, amount: '39.000', currency: 'USD', plan: 'silver',
        billing_interval: 'monthly', purchase_id: '11111111-2222-3333-4444-555555555555', can_succeed: true,
      }],
    });
    const res = makeRes();
    await getHostedCheckoutSession(makeReq(bearerFor(SESSION_ID)), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body.can_succeed).toBe(true);
    expect(res.body.return_url).toBe('https://app.macrocore.test/billing/checkout/return?purchase=11111111-2222-3333-4444-555555555555');
    const dataSql = String(mocks.poolQuery.mock.calls[1][0]);
    expect(dataSql).toContain('clock_timestamp() < sp.expires_at');
    expect(dataSql).not.toMatch(/\bnow\(\)/);
  });

  it('reports can_succeed=false after the window (display only — the settlement core re-checks under locks)', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [{ id: SESSION_ID, status: 'pending', resolved_at: null, amount: '39.000', currency: 'USD', plan: 'silver', billing_interval: 'monthly', purchase_id: 'p-1', can_succeed: false }],
    });
    const res = makeRes();
    await getHostedCheckoutSession(makeReq(bearerFor(SESSION_ID)), res, NOOP_NEXT);
    expect(res.body.can_succeed).toBe(false);
  });
});

describe('resolveHostedCheckoutSession — Stage B7', () => {
  it('passes the SESSION_EXPIRED code through on a 409 and writes no audit', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.resolveCheckoutSessionCore.mockResolvedValueOnce({ kind: 'conflict', code: 'SESSION_EXPIRED', message: 'window ended' });
    const res = makeRes();
    await resolveHostedCheckoutSession(makeReq(bearerFor(SESSION_ID), { outcome: 'succeeded' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'window ended', code: 'SESSION_EXPIRED' });
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('a purchase-applying success logs the resolve row (with purchase fields) and then subscription_purchase_applied, post-commit', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    const settled = { sessionId: SESSION_ID, attemptNewStatus: 'succeeded', sessionResolvedAt: '2026-09-24T09:00:00.000Z', invoiceId: 'inv-1' };
    const applied = { purchase_id: 'p-1', new_values: { plan: 'gold', subscription_status: 'active' } };
    mocks.resolveCheckoutSessionCore.mockResolvedValueOnce({
      kind: 'ok', result: settled, session: { id: SESSION_ID, status: 'succeeded', resolved_at: '2026-09-24T09:00:00.000Z' },
      purchaseApplied: applied, purchaseId: 'p-1',
    });
    mocks.buildAuditPayloadForResolve.mockReturnValueOnce({ action: 'payment_checkout_session_resolved' });
    mocks.buildAuditPayloadForPurchaseApplied.mockReturnValueOnce({ action: 'subscription_purchase_applied' });
    mocks.logAudit.mockResolvedValue(undefined);

    const res = makeRes();
    await resolveHostedCheckoutSession(makeReq(bearerFor(SESSION_ID), { outcome: 'succeeded' }), res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(mocks.buildAuditPayloadForResolve).toHaveBeenCalledWith(settled, 'simulated_hosted_page', { purchaseId: 'p-1', applied });
    expect(mocks.logAudit.mock.calls.map((c) => c[0].action)).toEqual(['payment_checkout_session_resolved', 'subscription_purchase_applied']);
    expect(mocks.logAudit.mock.calls[1][0].companyId).toBe('company-allowed');
  });
});
