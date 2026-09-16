import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Chat 5A / Stage B5 — release-owner clarification #3 on the approved v4
// design: "an executable audit-failure-isolation test: a rejected/failed
// logAudit call after a committed attempt creation must not change the 201
// result or remove the row; a rejected/failed logAudit call after a
// committed initiated -> failed transition must not change the 200 result
// or restore the old state."
//
// Mirrors adminSubscriptionActivationAuditFailureIsolation.test.ts /
// adminUpdateCompanyAuditFailureIsolation.test.ts's convention exactly:
// deliberately does NOT mock '../../utils/audit' — the REAL logAudit() runs,
// with only its own internal pool.query call (a separate statement/
// connection from createPaymentAttempt's own transaction, which uses
// pool.connect()) mocked to fail. Proves the real try/catch inside
// utils/audit.ts is what isolates a genuine audit_logs INSERT failure here,
// not an assumption about it.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
}));

vi.mock('../../db/pool', () => ({
  pool: {
    query: mocks.poolQuery, // pre-check / recovery lookups AND the REAL logAudit()'s internal INSERT
    connect: vi.fn(async () => ({ query: mocks.clientQuery, release: mocks.clientRelease })),
  },
}));
vi.mock('../../utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
// utils/whatsapp untouched (real module) — harmless, since neither
// 'admin_payment_attempt_initiated' nor 'admin_payment_attempt_failed' is in
// SENSITIVE_ACTIONS, so sendWhatsAppAlert() is never reached.

import { createPaymentAttempt, markPaymentAttemptFailed } from '../admin.controller';

const NOOP_NEXT = (() => {}) as any;

function makeRes(): Response & { statusCode?: number; body?: any } {
  const res: any = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
}

function makeReq(params: Record<string, string>, body: Record<string, unknown> = {}): Request {
  return { params, body, ip: '10.0.0.1', headers: { 'user-agent': 'vitest' } } as unknown as Request;
}

const ATTEMPT_ROW = {
  id: 'attempt-1',
  invoice_id: 'inv-1',
  company_id: 'company-1',
  subscription_id: 'sub-1',
  amount: '660.000',
  currency: 'USD',
  plan: 'gold',
  billing_interval: 'annual',
  period_start: '2026-09-15T00:00:00.000Z',
  period_end: '2027-09-15T00:00:00.000Z',
  idempotency_key: 'client-key-1',
  status: 'initiated',
  created_at: '2026-09-16T12:00:00.000Z',
  failed_at: null,
};

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

describe('createPaymentAttempt() + real logAudit() — audit_logs INSERT failure is fully isolated', () => {
  it('the transaction already committed and the 201 result (and the created row) are unaffected even though the subsequent audit INSERT throws', async () => {
    // First pool.query call: the idempotency-key pre-check (no existing row).
    // Second pool.query call: the REAL logAudit()'s own internal INSERT INTO
    // audit_logs — this is the one that fails.
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('simulated audit_logs INSERT failure'));

    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id, status FROM invoices')) return { rows: [{ id: 'inv-1', status: 'issued' }] };
      if (sql.includes('INSERT INTO payment_attempts')) return { rows: [ATTEMPT_ROW] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ invoiceId: 'inv-1' }, { idempotency_key: 'client-key-1' });
    const res = makeRes();

    await expect(createPaymentAttempt(req, res, NOOP_NEXT)).resolves.toBeUndefined();

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.payment_attempt.id).toBe('attempt-1');
    expect(res.body.payment_attempt.amount).toBe('660.000');

    // The transaction (client.query calls) fully committed before the audit
    // INSERT (pool.query, a separate connection) was ever attempted.
    const clientSqlCalls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(clientSqlCalls[clientSqlCalls.length - 1]).toBe('COMMIT');
    expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);

    expect(consoleErrorSpy).toHaveBeenCalledWith('audit log failed:', 'simulated audit_logs INSERT failure');
  });
});

describe('markPaymentAttemptFailed() + real logAudit() — audit_logs INSERT failure is fully isolated', () => {
  it('the initiated -> failed transition already committed and the 200 result (with the real failed_at) is unaffected even though the subsequent audit INSERT throws, and the row is never reverted', async () => {
    const failedRow = { ...ATTEMPT_ROW, status: 'failed', failed_at: '2026-09-16T13:00:00.000Z' };
    // First pool.query call: the guarded UPDATE itself (1 row affected).
    // Second pool.query call: the REAL logAudit()'s own internal INSERT.
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [failedRow] })
      .mockRejectedValueOnce(new Error('simulated audit_logs INSERT failure'));

    const req = makeReq({ id: 'attempt-1' });
    const res = makeRes();

    // markPaymentAttemptFailed's success branch uses an explicit `return
    // res.status(200).json(...)`, so the handler resolves to whatever
    // res.json() returns (the mocked res object itself here), unlike
    // createPaymentAttempt's success path above which has no trailing
    // `return` and so resolves to undefined. The point of this test is that
    // the call never rejects and the response below is unaffected — simply
    // awaiting it (any rejection would fail the test on its own) is enough.
    await markPaymentAttemptFailed(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.payment_attempt.status).toBe('failed');
    expect(res.body.payment_attempt.failed_at).toBe('2026-09-16T13:00:00.000Z');

    // No third pool.query call exists that could represent "reverting" the
    // UPDATE — the audit failure is the LAST thing that happens.
    expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
    const updateSql = (mocks.poolQuery.mock.calls[0][0] as string).replace(/\s+/g, ' ').trim();
    expect(updateSql).toBe("UPDATE payment_attempts SET status = 'failed' WHERE id = $1 AND status = 'initiated' RETURNING *, amount::text AS amount");

    expect(consoleErrorSpy).toHaveBeenCalledWith('audit log failed:', 'simulated audit_logs INSERT failure');
  });
});
