import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Chat 5A / Stage B5 — listPaymentAttempts() (a single pool.query()-only
// operation). markPaymentAttemptFailed() was reconciled in Stage B6 (design
// v5 §5.7) to lock invoice -> attempt -> session inside an explicit
// transaction (pool.connect()) rather than one autocommit UPDATE — its
// EXTERNAL contract for the zero-session case is unchanged bit-for-bit
// (same 404/409/200, same failed_at stamping), so both are asserted here,
// now against the new transactional mocking shape (same
// pool.connect()/client.query()/client.release() convention
// adminCreatePaymentAttempt.test.ts already establishes).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('../../db/pool', () => ({
  pool: {
    query: mocks.poolQuery,
    connect: vi.fn(async () => ({ query: mocks.clientQuery, release: mocks.clientRelease })),
  },
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
    // checkout_provider/settlement_provider default to null when the LEFT
    // JOINed payment_checkout_sessions row is absent (Stage B6, design v5 §5.5).
    expect(res.body.attempts[0].checkout_provider).toBeNull();
    expect(res.body.attempts[0].settlement_provider).toBeNull();
    const sql = mocks.poolQuery.mock.calls[1][0] as string;
    expect(sql).toContain('ORDER BY pa.created_at DESC');
    expect(sql).toContain('amount::text AS amount');
    expect(sql).toContain('LEFT JOIN payment_checkout_sessions pcs ON pcs.payment_attempt_id = pa.id');
  });
});

// Shared client.query() mock builder for markPaymentAttemptFailed's new
// transaction (Stage B6, design v5 §5.7): BEGIN -> invoice lock -> attempt
// lock -> [session lock -> settleOutcome's UPDATE(s) -> refresh SELECT] ->
// COMMIT, or ROLLBACK on an ineligible attempt. `sessionRow` is the
// already-locked payment_checkout_sessions row (or null for B5's original
// zero-session case).
function mockMarkFailedClientQueries(options: {
  attemptRow: Record<string, unknown>;
  sessionRow?: { id: string; status: string } | null;
  refreshedRow?: Record<string, unknown>;
}) {
  const { attemptRow, sessionRow = null, refreshedRow } = options;
  mocks.clientQuery.mockImplementation(async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
    if (sql.includes('SELECT id FROM invoices')) return { rows: [{ id: attemptRow.invoice_id }] };
    if (sql.includes('FOR UPDATE') && sql.includes('FROM payment_attempts')) return { rows: [attemptRow] };
    if (sql.includes('FROM payment_checkout_sessions')) return { rows: sessionRow ? [sessionRow] : [] };
    if (sql.includes('UPDATE payment_attempts SET status = $2')) {
      return { rows: [{ id: attemptRow.id, status: 'failed', failed_at: '2026-09-16T13:00:00.000Z' }] };
    }
    if (sql.includes('UPDATE payment_checkout_sessions SET status = $2')) {
      return { rows: [{ id: sessionRow?.id, status: 'failed', resolved_at: '2026-09-16T13:00:00.000Z' }] };
    }
    if (sql.includes('SELECT *, amount::text AS amount FROM payment_attempts WHERE id = $1')) {
      return { rows: [refreshedRow ?? { ...attemptRow, status: 'failed', failed_at: '2026-09-16T13:00:00.000Z' }] };
    }
    throw new Error(`unexpected client query: ${sql}`);
  });
}

describe('markPaymentAttemptFailed() — success', () => {
  it('locks invoice -> attempt -> session, writes via settleOutcome, commits, releases, and logs a best-effort audit row (design v5 §5.7)', async () => {
    const failedRow = { ...ATTEMPT_ROW, status: 'failed', failed_at: '2026-09-16T13:00:00.000Z' };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ invoice_id: 'inv-1' }] }); // routing pre-check
    mockMarkFailedClientQueries({ attemptRow: ATTEMPT_ROW, sessionRow: null, refreshedRow: failedRow });

    const req = makeReq({ id: 'attempt-1' });
    const res = makeRes();
    await markPaymentAttemptFailed(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body.payment_attempt.status).toBe('failed');
    // The response's failed_at comes straight from the query result the
    // (mocked) trigger/DB layer returned — never computed or set by
    // controller code.
    expect(res.body.payment_attempt.failed_at).toBe('2026-09-16T13:00:00.000Z');
    expect(res.body.payment_attempt.amount).toBe('660.000');
    // No session existed — checkout_provider/settlement_provider are null.
    expect(res.body.payment_attempt.checkout_provider).toBeNull();
    expect(res.body.payment_attempt.settlement_provider).toBeNull();

    const sqlCalls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls[0]).toBe('BEGIN');
    expect(sqlCalls[sqlCalls.length - 1]).toBe('COMMIT');
    expect(sqlCalls.some((s) => s.includes('SELECT id FROM invoices') && s.includes('FOR UPDATE'))).toBe(true);
    expect(sqlCalls.some((s) => s.includes('FROM payment_attempts') && s.includes('FOR UPDATE'))).toBe(true);
    expect(sqlCalls.some((s) => s.includes('FROM payment_checkout_sessions') && s.includes('FOR UPDATE'))).toBe(true);
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);

    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    const call = mocks.logAudit.mock.calls[0][0];
    expect(call.action).toBe('admin_payment_attempt_failed');
    expect(call.entityType).toBe('payment_attempts');
    expect(call.userId).toBeNull();
    expect(call.newValues).toEqual({ status: 'failed', failed_at: '2026-09-16T13:00:00.000Z' });
    expect(JSON.stringify(call.newValues)).not.toContain('idempotency_key');
  });

  it('cascades a pending session to failed in the SAME transaction and includes the cascade fields in the single audit row (design v5 §5.7/§8)', async () => {
    const failedRow = { ...ATTEMPT_ROW, status: 'failed', failed_at: '2026-09-16T13:00:00.000Z' };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ invoice_id: 'inv-1' }] });
    mockMarkFailedClientQueries({
      attemptRow: ATTEMPT_ROW,
      sessionRow: { id: 'session-1', status: 'pending' },
      refreshedRow: failedRow,
    });

    const res = makeRes();
    await markPaymentAttemptFailed(makeReq({ id: 'attempt-1' }), res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body.payment_attempt.checkout_provider).toBe('simulated');
    expect(res.body.payment_attempt.settlement_provider).toBeNull();

    const call = mocks.logAudit.mock.calls[0][0];
    expect(call.newValues).toEqual({
      status: 'failed',
      failed_at: '2026-09-16T13:00:00.000Z',
      checkout_session_id: 'session-1',
      checkout_session_status: 'failed',
      provider: 'simulated',
    });
  });
});

describe('markPaymentAttemptFailed() — not found / already resolved', () => {
  it('returns 404 when no attempt with this id exists at all (pre-transaction routing lookup)', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] }); // routing pre-check: not found
    await expect(markPaymentAttemptFailed(makeReq({ id: 'missing' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.clientQuery).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('returns 409 (never a replayed 200) when the attempt is already \'failed\', rolling back without ever calling settleOutcome', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ invoice_id: 'inv-1' }] });
    mockMarkFailedClientQueries({ attemptRow: { ...ATTEMPT_ROW, status: 'failed' } });

    const res = makeRes();
    await markPaymentAttemptFailed(makeReq({ id: 'attempt-1' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("already 'failed'");
    expect(mocks.logAudit).not.toHaveBeenCalled();

    const sqlCalls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls[sqlCalls.length - 1]).toBe('ROLLBACK');
    expect(sqlCalls.some((s) => s.includes('UPDATE payment_attempts SET status'))).toBe(false);
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });
});

describe('markPaymentAttemptFailed() — audit failure isolation (mocked logAudit)', () => {
  it('still returns 200 with the failed attempt even if the best-effort audit call rejects', async () => {
    const failedRow = { ...ATTEMPT_ROW, status: 'failed', failed_at: '2026-09-16T13:00:00.000Z' };
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ invoice_id: 'inv-1' }] });
    mockMarkFailedClientQueries({ attemptRow: ATTEMPT_ROW, sessionRow: null, refreshedRow: failedRow });
    mocks.logAudit.mockRejectedValueOnce(new Error('audit write failed'));

    const res = makeRes();
    await markPaymentAttemptFailed(makeReq({ id: 'attempt-1' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body.payment_attempt.status).toBe('failed');
  });
});
