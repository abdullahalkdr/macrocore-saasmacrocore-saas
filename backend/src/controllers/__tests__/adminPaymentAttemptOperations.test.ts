import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Chat 5A / Stage B5 — listPaymentAttempts() and markPaymentAttemptFailed().
// Both are single pool.query()-only operations (no pool.connect() /
// transaction) — no client mock needed here.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('../../db/pool', () => ({
  pool: { query: mocks.poolQuery },
}));
vi.mock('../../utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('../../utils/audit', () => ({ logAudit: mocks.logAudit }));

import { listPaymentAttempts, markPaymentAttemptFailed } from '../admin.controller';

const NOOP_NEXT = (() => {}) as any;

function makeRes(): Response & { statusCode?: number; body?: any } {
  const res: any = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
}

function makeReq(params: Record<string, string>): Request {
  return { params, body: {}, ip: '10.0.0.1', headers: { 'user-agent': 'vitest' } } as unknown as Request;
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
  idempotency_key: 'server-side-only-key',
  status: 'initiated',
  created_at: '2026-09-16T12:00:00.000Z',
  failed_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logAudit.mockResolvedValue(undefined);
});

describe('listPaymentAttempts()', () => {
  it('404s when the invoice does not exist, without ever querying payment_attempts', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(listPaymentAttempts(makeReq({ invoiceId: 'missing' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with an empty array when the invoice exists but has no attempts', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ x: 1 }] }); // invoice exists check
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] }); // attempts
    const res = makeRes();
    await listPaymentAttempts(makeReq({ invoiceId: 'inv-1' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, attempts: [] });
  });

  it('returns shaped attempts ordered by created_at DESC, never including idempotency_key', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ x: 1 }] });
    mocks.poolQuery.mockResolvedValueOnce({ rows: [ATTEMPT_ROW] });
    const res = makeRes();
    await listPaymentAttempts(makeReq({ invoiceId: 'inv-1' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body.attempts).toHaveLength(1);
    expect(res.body.attempts[0].id).toBe('attempt-1');
    expect(res.body.attempts[0].amount).toBe('660.000');
    expect(res.body.attempts[0].idempotency_key).toBeUndefined();
    const sql = mocks.poolQuery.mock.calls[1][0] as string;
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).toContain('amount::text AS amount');
  });
});

describe('markPaymentAttemptFailed() — success', () => {
  it('issues exactly UPDATE ... SET status = \'failed\' WHERE id = $1 AND status = \'initiated\' with no failed_at in the SET clause, returns 200, and logs a best-effort audit row', async () => {
    const failedRow = { ...ATTEMPT_ROW, status: 'failed', failed_at: '2026-09-16T13:00:00.000Z' };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [failedRow] });

    const req = makeReq({ id: 'attempt-1' });
    const res = makeRes();
    await markPaymentAttemptFailed(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body.payment_attempt.status).toBe('failed');
    // The response's failed_at comes straight from the query result the
    // (mocked) trigger/DB layer returned — never computed or set by
    // controller code.
    expect(res.body.payment_attempt.failed_at).toBe('2026-09-16T13:00:00.000Z');

    const [sql, params] = mocks.poolQuery.mock.calls[0];
    const normalized = (sql as string).replace(/\s+/g, ' ').trim();
    expect(normalized).toBe(
      "UPDATE payment_attempts SET status = 'failed' WHERE id = $1 AND status = 'initiated' RETURNING *, amount::text AS amount"
    );
    expect(normalized).not.toContain('failed_at');
    expect(res.body.payment_attempt.amount).toBe('660.000');
    expect(params).toEqual(['attempt-1']);

    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    const call = mocks.logAudit.mock.calls[0][0];
    expect(call.action).toBe('admin_payment_attempt_failed');
    expect(call.entityType).toBe('payment_attempts');
    expect(call.userId).toBeNull();
    expect(call.newValues).toEqual({ status: 'failed', failed_at: '2026-09-16T13:00:00.000Z' });
    expect(JSON.stringify(call.newValues)).not.toContain('idempotency_key');
  });
});

describe('markPaymentAttemptFailed() — not found / already resolved', () => {
  it('returns 404 when no attempt with this id exists at all', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE affects 0 rows
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] }); // existence lookup: not found
    await expect(markPaymentAttemptFailed(makeReq({ id: 'missing' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('returns 409 (never a replayed 200) when the attempt is already \'failed\'', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE affects 0 rows (status already 'failed')
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'attempt-1', status: 'failed' }] });
    const res = makeRes();
    await markPaymentAttemptFailed(makeReq({ id: 'attempt-1' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("already 'failed'");
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});

describe('markPaymentAttemptFailed() — audit failure isolation (mocked logAudit)', () => {
  it('still returns 200 with the failed attempt even if the best-effort audit call rejects', async () => {
    const failedRow = { ...ATTEMPT_ROW, status: 'failed', failed_at: '2026-09-16T13:00:00.000Z' };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [failedRow] });
    mocks.logAudit.mockRejectedValueOnce(new Error('audit write failed'));

    const res = makeRes();
    await markPaymentAttemptFailed(makeReq({ id: 'attempt-1' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body.payment_attempt.status).toBe('failed');
  });
});
