import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ============================================================================
// Chat 4B, Stage B4A — createSubscriptionInvoice() invoice-issued billing
// email wiring. Same conventions as adminActivateSubscriptionBillingEmail.test.ts
// (this file's sibling) and adminCreateSubscriptionInvoice.test.ts (the
// pre-existing B3 suite this stage must not weaken — left untouched).
//
// Reviewed design (baseline fa379ff): the billing email is resolved and
// enqueued STRICTLY POST-COMMIT, never inside the invoice transaction.
// resolveBillingRecipients and enqueueEmail are both mocked out here — their
// own behavior is covered by billingRecipients.test.ts and
// billingEmail.test.ts — so this file only proves the WIRING.
// ============================================================================

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  logAudit: vi.fn(),
  resolveBillingRecipients: vi.fn(),
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
vi.mock('../../utils/billingRecipients', () => ({ resolveBillingRecipients: mocks.resolveBillingRecipients }));
vi.mock('../../utils/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/email')>();
  return { ...actual, enqueueEmail: mocks.enqueueEmail };
});

import { createSubscriptionInvoice } from '../admin.controller';

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

const ACTIVE_SUBSCRIPTION_ROW = {
  id: 'sub-1',
  company_id: 'company-1',
  plan: 'gold',
  status: 'active',
  currency: 'USD',
  period_amount: 660,
  monthly_price: 55,
  billing_interval: 'annual',
  current_period_start: '2026-09-15T00:00:00.000Z',
  current_period_end: '2027-09-15T00:00:00.000Z',
  auto_renew: false,
  created_at: '2026-09-15T00:00:00.000Z',
};

const INVOICE_ROW = {
  id: 'inv-1',
  invoice_number: 'MC-SUB-000001',
  company_id: 'company-1',
  subscription_id: 'sub-1',
  plan: 'gold',
  billing_interval: 'annual',
  currency: 'USD',
  amount: 660,
  period_start: '2026-09-15T00:00:00.000Z',
  period_end: '2027-09-15T00:00:00.000Z',
  status: 'issued',
  issue_date: '2026-09-15T12:00:00.000Z',
  due_date: '2026-09-15T12:00:00.000Z',
  created_at: '2026-09-15T12:00:00.000Z',
};

function mockSuccessPool() {
  mocks.clientQuery.mockImplementation(async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return {};
    if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
    if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [ACTIVE_SUBSCRIPTION_ROW] };
    if (sql.includes('INSERT INTO invoices')) return { rows: [INVOICE_ROW] };
    throw new Error(`unexpected client query: ${sql}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logAudit.mockResolvedValue(undefined);
  mockSuccessPool();
  mocks.resolveBillingRecipients.mockResolvedValue([]);
  mocks.enqueueEmail.mockResolvedValue({ jobId: 'job-1', deduped: false });
});

describe('createSubscriptionInvoice() — invoice-issued billing email, post-commit wiring', () => {
  it('resolves recipients and enqueues the invoice email AFTER COMMIT, scoped to the company id', async () => {
    mocks.resolveBillingRecipients.mockResolvedValue([{ userId: 'user-1', email: 'admin@acme.example', preferredLanguage: 'en' }]);

    const req = makeReq({ id: 'company-1' });
    const res = makeRes();
    await createSubscriptionInvoice(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(201);
    expect(mocks.resolveBillingRecipients).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBillingRecipients).toHaveBeenCalledWith('company-1');

    const clientSqlCalls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(clientSqlCalls).toContain('COMMIT');
    expect(clientSqlCalls.some((s) => s.includes('email_jobs'))).toBe(false);

    expect(mocks.enqueueEmail).toHaveBeenCalledTimes(1);
    const enqueueArgs = mocks.enqueueEmail.mock.calls[0][0];
    expect(enqueueArgs.to).toBe('admin@acme.example');
    expect(enqueueArgs.category).toBe('billing');
    expect(enqueueArgs.lang).toBe('en');
    expect(enqueueArgs.companyId).toBe('company-1');
    expect(enqueueArgs.relatedEntityType).toBe('invoices');
    expect(enqueueArgs.relatedEntityId).toBe('inv-1');
    // Brief's exact dedup-key format: event type + invoice ID + recipient user id.
    expect(enqueueArgs.dedupKey).toBe('billing:invoice_issued:inv-1:user-1');
  });

  it('never calls enqueueEmail() before the invoice COMMIT has completed', async () => {
    const callOrder: string[] = [];
    mocks.resolveBillingRecipients.mockResolvedValue([{ userId: 'user-1', email: 'admin@acme.example', preferredLanguage: 'en' }]);
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      callOrder.push(`client:${sql}`);
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [ACTIVE_SUBSCRIPTION_ROW] };
      if (sql.includes('INSERT INTO invoices')) return { rows: [INVOICE_ROW] };
      throw new Error(`unexpected client query: ${sql}`);
    });
    mocks.enqueueEmail.mockImplementation(async () => {
      callOrder.push('enqueueEmail');
      return { jobId: 'job-1', deduped: false };
    });

    await createSubscriptionInvoice(makeReq({ id: 'company-1' }), makeRes(), NOOP_NEXT);

    expect(callOrder.indexOf('client:COMMIT')).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf('enqueueEmail')).toBeGreaterThan(callOrder.indexOf('client:COMMIT'));
  });

  it('the invoice email content reflects the exact invoice number/plan/interval/amount/currency/period/issue/due dates', async () => {
    mocks.resolveBillingRecipients.mockResolvedValue([{ userId: 'user-1', email: 'admin@acme.example', preferredLanguage: 'en' }]);
    await createSubscriptionInvoice(makeReq({ id: 'company-1' }), makeRes(), NOOP_NEXT);
    const enqueueArgs = mocks.enqueueEmail.mock.calls[0][0];
    expect(enqueueArgs.subject).toContain('MC-SUB-000001');
    expect(enqueueArgs.html).toContain('MC-SUB-000001');
    expect(enqueueArgs.html).toContain('Gold');
    expect(enqueueArgs.html).toContain('Annual');
    expect(enqueueArgs.html).toContain('660.00 USD');
    expect(enqueueArgs.html).toContain('2026-09-15');
    expect(enqueueArgs.html).toContain('2027-09-15');
    expect(enqueueArgs.html).toContain('/account?section=billing');
  });

  it('never claims a successful payment anywhere in the enqueued email', async () => {
    mocks.resolveBillingRecipients.mockResolvedValue([{ userId: 'user-1', email: 'admin@acme.example', preferredLanguage: 'en' }]);
    await createSubscriptionInvoice(makeReq({ id: 'company-1' }), makeRes(), NOOP_NEXT);
    const enqueueArgs = mocks.enqueueEmail.mock.calls[0][0];
    expect(enqueueArgs.html.toLowerCase()).not.toContain('payment');
    expect(enqueueArgs.html.toLowerCase()).not.toContain('paid');
  });

  it('sends one job per resolved recipient with its own dedup key and language', async () => {
    mocks.resolveBillingRecipients.mockResolvedValue([
      { userId: 'user-1', email: 'admin1@acme.example', preferredLanguage: 'en' },
      { userId: 'user-2', email: 'admin2@acme.example', preferredLanguage: 'ar' },
    ]);
    await createSubscriptionInvoice(makeReq({ id: 'company-1' }), makeRes(), NOOP_NEXT);
    expect(mocks.enqueueEmail).toHaveBeenCalledTimes(2);
    const calls = mocks.enqueueEmail.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.dedupKey).sort()).toEqual([
      'billing:invoice_issued:inv-1:user-1',
      'billing:invoice_issued:inv-1:user-2',
    ]);
    expect(calls.find((c) => c.to === 'admin2@acme.example').lang).toBe('ar');
  });

  it('a recipient-resolution failure never fails invoice creation, and enqueues nothing', async () => {
    mocks.resolveBillingRecipients.mockRejectedValue(new Error('resolver boom'));
    const res = makeRes();
    await createSubscriptionInvoice(makeReq({ id: 'company-1' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(201);
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });

  it('an enqueue failure for one recipient never blocks another recipient nor fails invoice creation', async () => {
    mocks.resolveBillingRecipients.mockResolvedValue([
      { userId: 'user-1', email: 'fails@acme.example', preferredLanguage: 'en' },
      { userId: 'user-2', email: 'succeeds@acme.example', preferredLanguage: 'en' },
    ]);
    mocks.enqueueEmail.mockImplementation(async (input: { to: string }) => {
      if (input.to === 'fails@acme.example') throw new Error('enqueue boom');
      return { jobId: 'job-2', deduped: false };
    });
    const res = makeRes();
    await createSubscriptionInvoice(makeReq({ id: 'company-1' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(201);
    expect(mocks.enqueueEmail).toHaveBeenCalledTimes(2);
  });

  it('the "no active subscription" 409 path never resolves recipients or enqueues an email', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const res = makeRes();
    await createSubscriptionInvoice(makeReq({ id: 'company-1' }), res, NOOP_NEXT);

    expect(res.statusCode).toBe(409);
    expect(mocks.resolveBillingRecipients).not.toHaveBeenCalled();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });

  it('the duplicate-period 409 conflict path never resolves recipients or enqueues an email', async () => {
    const conflictErr: any = new Error('duplicate key value violates unique constraint "invoices_one_invoice_per_period"');
    conflictErr.code = '23505';
    conflictErr.constraint = 'invoices_one_invoice_per_period';
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [ACTIVE_SUBSCRIPTION_ROW] };
      if (sql.includes('INSERT INTO invoices')) throw conflictErr;
      throw new Error(`unexpected client query: ${sql}`);
    });
    mocks.poolQuery.mockResolvedValue({ rows: [INVOICE_ROW] });

    const res = makeRes();
    await createSubscriptionInvoice(makeReq({ id: 'company-1' }), res, NOOP_NEXT);

    expect(res.statusCode).toBe(409);
    expect(mocks.resolveBillingRecipients).not.toHaveBeenCalled();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });

  it('a transaction rollback on an unexpected INSERT failure never resolves recipients or enqueues an email', async () => {
    const insertErr = new Error('simulated INSERT failure');
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [ACTIVE_SUBSCRIPTION_ROW] };
      if (sql.includes('INSERT INTO invoices')) throw insertErr;
      throw new Error(`unexpected client query: ${sql}`);
    });

    await expect(createSubscriptionInvoice(makeReq({ id: 'company-1' }), makeRes(), NOOP_NEXT)).rejects.toBe(insertErr);
    expect(mocks.resolveBillingRecipients).not.toHaveBeenCalled();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });

  it('the company-not-found 404 path never resolves recipients or enqueues an email', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    await expect(createSubscriptionInvoice(makeReq({ id: 'missing' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.resolveBillingRecipients).not.toHaveBeenCalled();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });
});
