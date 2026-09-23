import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Stage B6 — createCheckoutSession / getCheckoutSession / resolveCheckoutSession.
// Same mocking shape as adminCreatePaymentAttempt.test.ts (pool.query vs.
// pool.connect()'s own client, asyncHandler as a passthrough so a thrown
// AppError surfaces as a rejected promise). config/env is mocked with
// getters backed by mutable state so PAYMENT_SIMULATOR_OPERATIONAL and the
// company allowlist can vary per test without re-importing the module.
// resolveCheckoutSessionCore/buildAuditPayloadForResolve are mocked here —
// they have their own dedicated test coverage in paymentSettlement.test.ts —
// so this file verifies only how admin.controller.ts wires around them
// (live re-gating, 404/409/200 mapping, post-commit-only audit).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  logAudit: vi.fn(),
  resolveCheckoutSessionCore: vi.fn(),
  buildAuditPayloadForResolve: vi.fn(),
}));

const envState = vi.hoisted(() => ({
  operational: true,
  companyIds: ['company-allowed'],
  baseUrl: 'https://pay.example.com',
}));

vi.mock('../../db/pool', () => ({
  pool: {
    query: mocks.poolQuery,
    connect: vi.fn(async () => ({ query: mocks.clientQuery, release: mocks.clientRelease })),
  },
}));
vi.mock('../../utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('../../utils/audit', () => ({ logAudit: mocks.logAudit }));
vi.mock('../../config/env', () => ({
  env: {
    get PAYMENT_SIMULATOR_COMPANY_IDS() {
      return envState.companyIds;
    },
    PAYMENT_SIMULATOR_TOKEN_SECRET: 'test-secret-at-least-32-bytes-long-ok',
  },
  get PAYMENT_SIMULATOR_OPERATIONAL() {
    return envState.operational;
  },
  get PAYMENT_SIMULATOR_BASE_URL() {
    return envState.baseUrl;
  },
}));
vi.mock('../../services/paymentSettlement', () => ({
  resolveCheckoutSessionCore: mocks.resolveCheckoutSessionCore,
  buildAuditPayloadForResolve: mocks.buildAuditPayloadForResolve,
  settleOutcome: vi.fn(),
  buildAuditPayloadForMarkFailed: vi.fn(),
}));

import { createCheckoutSession, getCheckoutSession, resolveCheckoutSession } from '../admin.controller';

const NOOP_NEXT = (() => {}) as any;

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

function makeReq(params: Record<string, string>, body: Record<string, unknown> = {}): Request {
  return { params, body, ip: '10.0.0.1', headers: { 'user-agent': 'vitest' } } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  envState.operational = true;
  envState.companyIds = ['company-allowed'];
  envState.baseUrl = 'https://pay.example.com';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCheckoutSession', () => {
  it('returns 404 when the payment attempt does not exist (before ever connecting a client)', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeReq({ id: 'attempt-missing' });
    const res = makeRes();

    await expect(createCheckoutSession(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it('rolls back and returns 404 when the invoice lock finds no row', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ invoice_id: 'invoice-1' }] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('FROM invoices')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'attempt-1' });
    const res = makeRes();

    await expect(createCheckoutSession(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });

  it('rolls back and returns 404 when the re-locked attempt does not belong to the routing invoice', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ invoice_id: 'invoice-1' }] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('FROM invoices')) return { rows: [{ id: 'invoice-1', status: 'issued' }] };
      if (sql.includes('FROM payment_attempts')) {
        return { rows: [{ id: 'attempt-1', invoice_id: 'some-other-invoice', company_id: 'company-allowed', status: 'initiated' }] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'attempt-1' });
    const res = makeRes();

    await expect(createCheckoutSession(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns 403 when the attempt company is not allowlisted, rolling back first', async () => {
    envState.companyIds = ['some-other-company'];
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ invoice_id: 'invoice-1' }] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('FROM invoices')) return { rows: [{ id: 'invoice-1', status: 'issued' }] };
      if (sql.includes('FROM payment_attempts')) {
        return { rows: [{ id: 'attempt-1', invoice_id: 'invoice-1', company_id: 'company-not-allowed', status: 'initiated' }] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'attempt-1' });
    const res = makeRes();

    await createCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Payment simulator is not enabled for this company' });
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('replays an existing session as-is (200, not 201) without re-checking eligibility or calling audit', async () => {
    const existingSession = {
      id: 'session-existing',
      payment_attempt_id: 'attempt-1',
      provider: 'simulated',
      status: 'succeeded', // even though attempt might not be 'initiated' any more
      created_at: '2026-09-15T00:00:00.000Z',
      resolved_at: '2026-09-16T00:00:00.000Z',
    };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ invoice_id: 'invoice-1' }] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('FROM invoices')) return { rows: [{ id: 'invoice-1', status: 'paid' }] };
      if (sql.includes('FROM payment_attempts')) {
        return { rows: [{ id: 'attempt-1', invoice_id: 'invoice-1', company_id: 'company-allowed', status: 'succeeded' }] };
      }
      if (sql.includes('FROM payment_checkout_sessions')) {
        return { rows: [existingSession] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'attempt-1' });
    const res = makeRes();

    await createCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.checkout_session.id).toBe('session-existing');
    expect(res.body.checkout_session.status).toBe('succeeded');
    expect(res.body.checkout_session.checkout_url).toContain('session-existing.');
    expect(mocks.clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(mocks.clientQuery).not.toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('rolls back and returns 409 when no session exists yet and the attempt is not initiated', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ invoice_id: 'invoice-1' }] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('FROM invoices')) return { rows: [{ id: 'invoice-1', status: 'issued' }] };
      if (sql.includes('FROM payment_attempts')) {
        return { rows: [{ id: 'attempt-1', invoice_id: 'invoice-1', company_id: 'company-allowed', status: 'failed' }] };
      }
      if (sql.includes('FROM payment_checkout_sessions')) {
        return { rows: [] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'attempt-1' });
    const res = makeRes();

    await createCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'Payment attempt is not eligible for a checkout session' });
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rolls back and returns 409 when no session exists and the invoice is no longer issued', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ invoice_id: 'invoice-1' }] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('FROM invoices')) return { rows: [{ id: 'invoice-1', status: 'paid' }] };
      if (sql.includes('FROM payment_attempts')) {
        return { rows: [{ id: 'attempt-1', invoice_id: 'invoice-1', company_id: 'company-allowed', status: 'initiated' }] };
      }
      if (sql.includes('FROM payment_checkout_sessions')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const res = makeRes();
    await createCheckoutSession(makeReq({ id: 'attempt-1' }), res, NOOP_NEXT);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'Payment attempt is not eligible for a checkout session' });
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO payment_checkout_sessions'))).toBe(false);
  });

  it('creates a new session (201), commits, and fires the post-commit audit with the new session shape', async () => {
    const newSession = {
      id: 'session-new',
      payment_attempt_id: 'attempt-1',
      provider: 'simulated',
      status: 'pending',
      created_at: '2026-09-17T00:00:00.000Z',
      resolved_at: null,
    };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ invoice_id: 'invoice-1' }] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('FROM invoices')) return { rows: [{ id: 'invoice-1', status: 'issued' }] };
      if (sql.includes('FROM payment_attempts')) {
        return { rows: [{ id: 'attempt-1', invoice_id: 'invoice-1', company_id: 'company-allowed', status: 'initiated' }] };
      }
      if (sql.startsWith('SELECT *') && sql.includes('FROM payment_checkout_sessions')) {
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO payment_checkout_sessions')) {
        return { rows: [newSession] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'attempt-1' });
    const res = makeRes();

    await createCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(201);
    expect(res.body.checkout_session.id).toBe('session-new');
    expect(res.body.checkout_session.checkout_url).toMatch(/^https:\/\/pay\.example\.com\/simulated-checkout#session-new\./);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    const auditCall = mocks.logAudit.mock.calls[0][0];
    expect(auditCall.companyId).toBe('company-allowed');
    expect(auditCall.action).toBe('admin_payment_checkout_session_created');
    expect(auditCall.entityType).toBe('payment_checkout_sessions');
    expect(auditCall.entityId).toBe('session-new');
    expect(auditCall.newValues).toEqual({
      payment_attempt_id: 'attempt-1',
      invoice_id: 'invoice-1',
      provider: 'simulated',
    });
  });

  it('still returns 201 with the created session even if the best-effort audit call rejects', async () => {
    const newSession = {
      id: 'session-new',
      payment_attempt_id: 'attempt-1',
      provider: 'simulated',
      status: 'pending',
      created_at: '2026-09-17T00:00:00.000Z',
      resolved_at: null,
    };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ invoice_id: 'invoice-1' }] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('FROM invoices')) return { rows: [{ id: 'invoice-1', status: 'issued' }] };
      if (sql.includes('FROM payment_attempts')) {
        return { rows: [{ id: 'attempt-1', invoice_id: 'invoice-1', company_id: 'company-allowed', status: 'initiated' }] };
      }
      if (sql.startsWith('SELECT *') && sql.includes('FROM payment_checkout_sessions')) {
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO payment_checkout_sessions')) {
        return { rows: [newSession] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    });
    mocks.logAudit.mockRejectedValueOnce(new Error('audit sink unavailable'));

    const req = makeReq({ id: 'attempt-1' });
    const res = makeRes();

    await createCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

describe('getCheckoutSession', () => {
  it('returns 404 when the payment attempt does not exist', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = makeReq({ id: 'attempt-missing' });
    const res = makeRes();

    await expect(getCheckoutSession(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns 403 when the company is not allowlisted', async () => {
    envState.companyIds = ['someone-else'];
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'attempt-1', company_id: 'company-not-allowed' }] });
    const req = makeReq({ id: 'attempt-1' });
    const res = makeRes();

    await getCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(403);
  });

  it('returns 200 with checkout_session: null when no session has been created yet', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'attempt-1', company_id: 'company-allowed' }] });
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = makeReq({ id: 'attempt-1' });
    const res = makeRes();

    await getCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, checkout_session: null });
  });

  it('returns 200 with the shaped session and a freshly-recomputed checkout_url when a session exists', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'attempt-1', company_id: 'company-allowed' }] });
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'session-1',
          payment_attempt_id: 'attempt-1',
          provider: 'simulated',
          status: 'pending',
          created_at: '2026-09-17T00:00:00.000Z',
          resolved_at: null,
        },
      ],
    });
    const req = makeReq({ id: 'attempt-1' });
    const res = makeRes();

    await getCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body.checkout_session).toMatchObject({
      id: 'session-1',
      payment_attempt_id: 'attempt-1',
      provider: 'simulated',
      status: 'pending',
      created_at: '2026-09-17T00:00:00.000Z',
      resolved_at: null,
    });
    expect(res.body.checkout_session.checkout_url).toMatch(/^https:\/\/pay\.example\.com\/simulated-checkout#session-1\./);
  });
});

describe('resolveCheckoutSession', () => {
  it('returns 400 when outcome is missing', async () => {
    const req = makeReq({ id: 'session-1' }, {});
    const res = makeRes();

    await expect(resolveCheckoutSession(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when outcome is not one of the supported values', async () => {
    const req = makeReq({ id: 'session-1' }, { outcome: 'refunded' });
    const res = makeRes();

    await expect(resolveCheckoutSession(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns 404 when the session/attempt routing join finds nothing', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = makeReq({ id: 'session-missing' }, { outcome: 'succeeded' });
    const res = makeRes();

    await expect(resolveCheckoutSession(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.resolveCheckoutSessionCore).not.toHaveBeenCalled();
  });

  it('returns 403 when the routed company is not allowlisted, without calling the settlement core', async () => {
    envState.companyIds = ['someone-else'];
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-not-allowed' }] });
    const req = makeReq({ id: 'session-1' }, { outcome: 'succeeded' });
    const res = makeRes();

    await resolveCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(403);
    expect(mocks.resolveCheckoutSessionCore).not.toHaveBeenCalled();
  });

  it('returns 404 when the settlement core reports not_found', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.resolveCheckoutSessionCore.mockResolvedValueOnce({ kind: 'not_found' });
    const req = makeReq({ id: 'session-1' }, { outcome: 'succeeded' });
    const res = makeRes();

    await expect(resolveCheckoutSession(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns 409 with the core-provided message when the settlement core reports a conflict', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.resolveCheckoutSessionCore.mockResolvedValueOnce({ kind: 'conflict', message: 'already resolved' });
    const req = makeReq({ id: 'session-1' }, { outcome: 'succeeded' });
    const res = makeRes();

    await resolveCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'already resolved' });
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('returns 200 with checkout_session + invoice on a successful settlement, and audits post-commit with resolvedVia=admin_api', async () => {
    const resolvedAt = '2026-09-17T12:00:00.000Z';
    const okResult = {
      kind: 'ok' as const,
      result: {
        attemptId: 'attempt-1',
        attemptNewStatus: 'succeeded' as const,
        attemptResolvedAt: resolvedAt,
        sessionId: 'session-1',
        sessionExisted: true,
        sessionResolvedAt: resolvedAt,
        invoiceId: 'invoice-1',
        invoiceNewStatus: 'paid' as const,
        invoicePaymentDate: resolvedAt,
      },
      session: { id: 'session-1', status: 'succeeded' as const, resolved_at: resolvedAt },
    };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.resolveCheckoutSessionCore.mockResolvedValueOnce(okResult);
    mocks.buildAuditPayloadForResolve.mockReturnValueOnce({
      action: 'payment_checkout_session_resolved',
      entityType: 'payment_checkout_sessions',
      entityId: 'session-1',
      oldValues: { status: 'pending' },
      newValues: { status: 'succeeded' },
    });

    const req = makeReq({ id: 'session-1' }, { outcome: 'succeeded' });
    const res = makeRes();

    await resolveCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      checkout_session: { id: 'session-1', provider: 'simulated', status: 'succeeded', resolved_at: resolvedAt },
      invoice: { id: 'invoice-1', status: 'paid', payment_date: resolvedAt },
    });
    expect(mocks.buildAuditPayloadForResolve).toHaveBeenCalledWith(okResult.result, 'admin_api');
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit.mock.calls[0][0].companyId).toBe('company-allowed');
  });

  it('omits the invoice field when the outcome did not touch an invoice (e.g. failed)', async () => {
    const okResult = {
      kind: 'ok' as const,
      result: {
        attemptId: 'attempt-1',
        attemptNewStatus: 'failed' as const,
        attemptResolvedAt: '2026-09-17T12:00:00.000Z',
        sessionId: 'session-1',
        sessionExisted: true,
        sessionResolvedAt: '2026-09-17T12:00:00.000Z',
        invoiceId: null,
        invoiceNewStatus: null,
        invoicePaymentDate: null,
      },
      session: { id: 'session-1', status: 'failed' as const, resolved_at: '2026-09-17T12:00:00.000Z' },
    };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.resolveCheckoutSessionCore.mockResolvedValueOnce(okResult);
    mocks.buildAuditPayloadForResolve.mockReturnValueOnce({});

    const req = makeReq({ id: 'session-1' }, { outcome: 'failed' });
    const res = makeRes();

    await resolveCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      checkout_session: { id: 'session-1', provider: 'simulated', status: 'failed', resolved_at: '2026-09-17T12:00:00.000Z' },
    });
    expect(res.body.invoice).toBeUndefined();
  });

  it('still returns 200 even if the best-effort resolve audit call rejects', async () => {
    const okResult = {
      kind: 'ok' as const,
      result: {
        attemptId: 'attempt-1',
        attemptNewStatus: 'cancelled' as const,
        attemptResolvedAt: '2026-09-17T12:00:00.000Z',
        sessionId: 'session-1',
        sessionExisted: true,
        sessionResolvedAt: '2026-09-17T12:00:00.000Z',
        invoiceId: null,
        invoiceNewStatus: null,
        invoicePaymentDate: null,
      },
      session: { id: 'session-1', status: 'cancelled' as const, resolved_at: '2026-09-17T12:00:00.000Z' },
    };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ company_id: 'company-allowed' }] });
    mocks.resolveCheckoutSessionCore.mockResolvedValueOnce(okResult);
    mocks.buildAuditPayloadForResolve.mockReturnValueOnce({});
    mocks.logAudit.mockRejectedValueOnce(new Error('audit sink unavailable'));

    const req = makeReq({ id: 'session-1' }, { outcome: 'cancelled' });
    const res = makeRes();

    await resolveCheckoutSession(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
