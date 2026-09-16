import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Chat 5A / Stage B5 — createPaymentAttempt().
// Mocks pool.connect() to return a fake client with its own query/release,
// separate from pool.query() (used by the pre-transaction idempotency-key
// replay check, and by the post-rollback recovery lookups in the conflict
// path) — same mocking shape as adminCreateSubscriptionInvoice.test.ts.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  logAudit: vi.fn(),
  enqueueEmail: vi.fn(),
}));

vi.mock('../../db/pool', () => ({
  pool: {
    query: mocks.poolQuery,
    connect: vi.fn(async () => ({ query: mocks.clientQuery, release: mocks.clientRelease })),
  },
}));
vi.mock('../../utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('../../utils/audit', () => ({ logAudit: mocks.logAudit }));
vi.mock('../../utils/email', () => ({
  enqueueEmail: mocks.enqueueEmail,
  subscriptionActivatedEmailHtml: vi.fn(),
  subscriptionInvoiceIssuedEmailHtml: vi.fn(),
}));

import { createPaymentAttempt } from '../admin.controller';

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
  same_invoice: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logAudit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createPaymentAttempt() — validation', () => {
  it('rejects a missing idempotency_key with 400, before ever touching the database', async () => {
    const req = makeReq({ invoiceId: 'inv-1' }, {});
    const res = makeRes();
    await expect(createPaymentAttempt(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only idempotency_key with 400', async () => {
    const req = makeReq({ invoiceId: 'inv-1' }, { idempotency_key: '   ' });
    const res = makeRes();
    await expect(createPaymentAttempt(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an idempotency_key longer than 100 characters (after trimming) with 400', async () => {
    const req = makeReq({ invoiceId: 'inv-1' }, { idempotency_key: 'x'.repeat(101) });
    const res = makeRes();
    await expect(createPaymentAttempt(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('trims the idempotency_key before ever querying the database', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id, status FROM invoices')) return { rows: [{ id: 'inv-1', status: 'issued' }] };
      if (sql.includes('INSERT INTO payment_attempts')) return { rows: [ATTEMPT_ROW] };
      throw new Error(`unexpected client query: ${sql}`);
    });
    await createPaymentAttempt(makeReq({ invoiceId: 'inv-1' }, { idempotency_key: '  client-key-1  ' }), makeRes(), NOOP_NEXT);
    expect(mocks.poolQuery.mock.calls[0][1]).toEqual(['client-key-1', 'inv-1']);
  });
});

describe('createPaymentAttempt() — idempotent replay before any transaction', () => {
  it('returns 200 with the existing attempt when the key already exists for the SAME invoice, and never opens a transaction', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [ATTEMPT_ROW] });
    const req = makeReq({ invoiceId: 'inv-1' }, { idempotency_key: 'client-key-1' });
    const res = makeRes();
    await createPaymentAttempt(req, res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.payment_attempt.id).toBe('attempt-1');
    expect(res.body.payment_attempt.amount).toBe('660.000');
    expect(res.body.payment_attempt.idempotency_key).toBeUndefined();
    expect(mocks.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining('amount::text AS amount'),
      ['client-key-1', 'inv-1']
    );
    expect(mocks.clientQuery).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('returns 409 when the key already exists for a DIFFERENT invoice, and never opens a transaction', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ ...ATTEMPT_ROW, invoice_id: 'inv-other', same_invoice: false }] });
    const req = makeReq({ invoiceId: 'inv-1' }, { idempotency_key: 'client-key-1' });
    const res = makeRes();
    await createPaymentAttempt(req, res, NOOP_NEXT);
    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });
});

describe('createPaymentAttempt() — success path', () => {
  it('locks the invoice, inserts via INSERT ... SELECT, commits, releases, and logs a best-effort audit row', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] }); // pre-check: no existing key
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id, status FROM invoices')) return { rows: [{ id: 'inv-1', status: 'issued' }] };
      if (sql.includes('INSERT INTO payment_attempts')) return { rows: [ATTEMPT_ROW] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ invoiceId: 'inv-1' }, { idempotency_key: 'client-key-1' });
    const res = makeRes();
    await createPaymentAttempt(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.payment_attempt.id).toBe('attempt-1');
    expect(res.body.payment_attempt.amount).toBe('660.000');
    expect(res.body.payment_attempt.idempotency_key).toBeUndefined();
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);

    const sqlCalls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls[0]).toBe('BEGIN');
    expect(sqlCalls[sqlCalls.length - 1]).toBe('COMMIT');
    expect(sqlCalls.some((s) => s.includes('SELECT id, status FROM invoices') && s.includes('FOR UPDATE'))).toBe(true);
    expect(sqlCalls.some((s) => s.includes('RETURNING *, amount::text AS amount'))).toBe(true);
    expect(sqlCalls.join('\n')).not.toMatch(/UPDATE\s+(companies|subscriptions|invoices)/i);
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    const call = mocks.logAudit.mock.calls[0][0];
    expect(call.action).toBe('admin_payment_attempt_initiated');
    expect(call.entityType).toBe('payment_attempts');
    expect(call.userId).toBeNull();
    expect(call.newValues).toEqual({
      invoice_id: 'inv-1',
      company_id: 'company-1',
      subscription_id: 'sub-1',
      amount: '660.000',
      currency: 'USD',
      plan: 'gold',
      billing_interval: 'annual',
      period_start: '2026-09-15T00:00:00.000Z',
      period_end: '2027-09-15T00:00:00.000Z',
      status: 'initiated',
    });
    expect(JSON.stringify(call.newValues)).not.toContain('idempotency_key');
  });

  it('INSERT ... SELECT never binds any client-supplied decoy field — only invoiceId and the trimmed key are parameters', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    let insertParams: unknown[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id, status FROM invoices')) return { rows: [{ id: 'inv-1', status: 'issued' }] };
      if (sql.includes('INSERT INTO payment_attempts')) {
        insertParams = params || [];
        return { rows: [ATTEMPT_ROW] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    });
    await createPaymentAttempt(
      makeReq({ invoiceId: 'inv-1' }, { idempotency_key: 'client-key-1', amount: 999999, currency: 'ZZZ', status: 'failed', id: 'attacker-chosen-id' }),
      makeRes(),
      NOOP_NEXT
    );
    expect(insertParams).toEqual(['inv-1', 'client-key-1']);
  });
});

describe('createPaymentAttempt() — invoice not found / not eligible', () => {
  it('rolls back and throws 404 when the invoice does not exist', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id, status FROM invoices')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });
    const req = makeReq({ invoiceId: 'missing' }, { idempotency_key: 'client-key-1' });
    const res = makeRes();
    await expect(createPaymentAttempt(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when the invoice exists but is not \'issued\' (mocked — invoices_status_valid makes this unreachable in real Postgres today, so this path is covered here, not in SMOKE_B5)', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id, status FROM invoices')) return { rows: [{ id: 'inv-1', status: 'void' }] };
      throw new Error(`unexpected client query: ${sql}`);
    });
    const req = makeReq({ invoiceId: 'inv-1' }, { idempotency_key: 'client-key-1' });
    const res = makeRes();
    await createPaymentAttempt(req, res, NOOP_NEXT);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'Invoice is not eligible for a payment attempt' });
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});

describe('createPaymentAttempt() — 23505 fixed-order recovery', () => {
  it('same key, same invoice found in recovery -> 200 with the existing attempt', async () => {
    const conflictErr: any = new Error('duplicate key value violates unique constraint "payment_attempts_idempotency_key_unique"');
    conflictErr.code = '23505';
    conflictErr.constraint = 'payment_attempts_idempotency_key_unique';

    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] }) // pre-check
      .mockResolvedValueOnce({ rows: [ATTEMPT_ROW] }); // recovery lookup by key
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id, status FROM invoices')) return { rows: [{ id: 'inv-1', status: 'issued' }] };
      if (sql.includes('INSERT INTO payment_attempts')) throw conflictErr;
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ invoiceId: 'inv-1' }, { idempotency_key: 'client-key-1' });
    const res = makeRes();
    await createPaymentAttempt(req, res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body.payment_attempt.id).toBe('attempt-1');
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('same key, different invoice found in recovery -> 409', async () => {
    const conflictErr: any = new Error('duplicate key value violates unique constraint "payment_attempts_idempotency_key_unique"');
    conflictErr.code = '23505';

    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...ATTEMPT_ROW, invoice_id: 'inv-other', same_invoice: false }] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id, status FROM invoices')) return { rows: [{ id: 'inv-1', status: 'issued' }] };
      if (sql.includes('INSERT INTO payment_attempts')) throw conflictErr;
      throw new Error(`unexpected client query: ${sql}`);
    });

    const res = makeRes();
    await createPaymentAttempt(makeReq({ invoiceId: 'inv-1' }, { idempotency_key: 'client-key-1' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain('idempotency key');
  });

  it('key not found in recovery, but an active attempt exists for this invoice -> 409 with existing_attempt', async () => {
    const conflictErr: any = new Error('duplicate key value violates unique constraint "payment_attempts_one_active_per_invoice"');
    conflictErr.code = '23505';

    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] }) // pre-check
      .mockResolvedValueOnce({ rows: [] }) // recovery by key: not found
      .mockResolvedValueOnce({ rows: [ATTEMPT_ROW] }); // active-existing lookup
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id, status FROM invoices')) return { rows: [{ id: 'inv-1', status: 'issued' }] };
      if (sql.includes('INSERT INTO payment_attempts')) throw conflictErr;
      throw new Error(`unexpected client query: ${sql}`);
    });

    const res = makeRes();
    await createPaymentAttempt(makeReq({ invoiceId: 'inv-1' }, { idempotency_key: 'a-fresh-key' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(409);
    expect(res.body.existing_attempt.id).toBe('attempt-1');
  });

  it('23505 explained by neither recovery lookup is rethrown as a real error, never mis-reported as a known conflict', async () => {
    const conflictErr: any = new Error('duplicate key value violates unique constraint "payment_attempts_pkey"');
    conflictErr.code = '23505';

    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id, status FROM invoices')) return { rows: [{ id: 'inv-1', status: 'issued' }] };
      if (sql.includes('INSERT INTO payment_attempts')) throw conflictErr;
      throw new Error(`unexpected client query: ${sql}`);
    });

    await expect(
      createPaymentAttempt(makeReq({ invoiceId: 'inv-1' }, { idempotency_key: 'a-fresh-key' }), makeRes(), NOOP_NEXT)
    ).rejects.toBe(conflictErr);
  });
});

describe('createPaymentAttempt() — transaction rollback on unexpected failure', () => {
  it('rolls back if the INSERT fails for a reason other than 23505', async () => {
    const insertErr = new Error('simulated INSERT failure');
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    const calls: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id, status FROM invoices')) return { rows: [{ id: 'inv-1', status: 'issued' }] };
      if (sql.includes('INSERT INTO payment_attempts')) throw insertErr;
      throw new Error(`unexpected client query: ${sql}`);
    });

    await expect(
      createPaymentAttempt(makeReq({ invoiceId: 'inv-1' }, { idempotency_key: 'client-key-1' }), makeRes(), NOOP_NEXT)
    ).rejects.toBe(insertErr);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });
});

describe('createPaymentAttempt() — audit failure isolation (mocked logAudit)', () => {
  it('still returns 201 with the created attempt even if the best-effort audit call rejects', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id, status FROM invoices')) return { rows: [{ id: 'inv-1', status: 'issued' }] };
      if (sql.includes('INSERT INTO payment_attempts')) return { rows: [ATTEMPT_ROW] };
      throw new Error(`unexpected client query: ${sql}`);
    });
    mocks.logAudit.mockRejectedValueOnce(new Error('audit write failed'));

    const req = makeReq({ invoiceId: 'inv-1' }, { idempotency_key: 'client-key-1' });
    const res = makeRes();
    await createPaymentAttempt(req, res, NOOP_NEXT);
    expect(res.statusCode).toBe(201);
    expect(res.body.payment_attempt.id).toBe('attempt-1');
  });
});
