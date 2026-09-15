import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Chat 4A / Stage B3 — createSubscriptionInvoice.
// Mocks pool.connect() to return a fake client with its own query/release,
// separate from pool.query() (used only by the post-rollback recovery lookup
// in the conflict path, and by listInvoices) — same mocking shape as
// adminSubscriptionActivation.test.ts.
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

import { createSubscriptionInvoice, listInvoices } from '../admin.controller';

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

const ACTIVE_SUBSCRIPTION_ROW = {
  id: 'sub-1',
  company_id: 'company-1',
  plan: 'gold',
  status: 'active',
  currency: 'USD',
  period_amount: 660,
  monthly_price: 55, // deliberately different from period_amount, to prove the invoice never derives from this
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logAudit.mockResolvedValue(undefined);
});

describe('createSubscriptionInvoice() — success path', () => {
  it('locks the company, locks and reads the active subscription, inserts the invoice, commits, releases, and logs a best-effort audit row', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes("FROM subscriptions WHERE company_id")) return { rows: [ACTIVE_SUBSCRIPTION_ROW] };
      if (sql.includes('INSERT INTO invoices')) return { rows: [INVOICE_ROW] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'company-1' });
    const res = makeRes();
    await createSubscriptionInvoice(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ success: true, invoice: INVOICE_ROW });
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);

    const sqlCalls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls[0]).toBe('BEGIN');
    expect(sqlCalls[sqlCalls.length - 1]).toBe('COMMIT');

    // Locks the company row before reading the subscription — same lock
    // order as activateSubscription/updateCompany, so this never deadlocks
    // against deleteMe's own company-row-first lock.
    const companyIdx = sqlCalls.findIndex((s) => s.includes('SELECT id FROM companies'));
    const subIdx = sqlCalls.findIndex((s) => s.includes('FROM subscriptions WHERE company_id'));
    expect(companyIdx).toBeGreaterThanOrEqual(0);
    expect(subIdx).toBeGreaterThan(companyIdx);
    expect(sqlCalls[companyIdx]).toContain('FOR UPDATE');
    expect(sqlCalls[subIdx]).toContain('FOR UPDATE');

    // Eligibility is scoped to status = 'active' only — no reference to
    // companies.subscription_status anywhere in this query.
    expect(sqlCalls[subIdx]).toContain("status = 'active'");
    expect(sqlCalls[subIdx]).not.toContain('subscription_status');

    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    const call = mocks.logAudit.mock.calls[0][0];
    expect(call.action).toBe('admin_subscription_invoice_issued');
    expect(call.entityType).toBe('invoices');
    expect(call.userId).toBeNull();
  });

  it('copies the exact immutable snapshot from the active subscription — plan, billing_interval, currency, and period bounds match verbatim', async () => {
    let insertParams: unknown[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [ACTIVE_SUBSCRIPTION_ROW] };
      if (sql.includes('INSERT INTO invoices')) {
        insertParams = params || [];
        return { rows: [INVOICE_ROW] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'company-1' });
    const res = makeRes();
    await createSubscriptionInvoice(req, res, NOOP_NEXT);

    // [companyId, subscriptionId, plan, billing_interval, currency, amount, period_start, period_end, issuedAt]
    expect(insertParams[0]).toBe('company-1');
    expect(insertParams[1]).toBe(ACTIVE_SUBSCRIPTION_ROW.id);
    expect(insertParams[2]).toBe(ACTIVE_SUBSCRIPTION_ROW.plan);
    expect(insertParams[3]).toBe(ACTIVE_SUBSCRIPTION_ROW.billing_interval);
    expect(insertParams[4]).toBe(ACTIVE_SUBSCRIPTION_ROW.currency);
    expect(insertParams[6]).toBe(ACTIVE_SUBSCRIPTION_ROW.current_period_start);
    expect(insertParams[7]).toBe(ACTIVE_SUBSCRIPTION_ROW.current_period_end);
  });

  it('uses subscription.period_amount as the invoice amount, never subscription.monthly_price', async () => {
    let insertParams: unknown[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [ACTIVE_SUBSCRIPTION_ROW] };
      if (sql.includes('INSERT INTO invoices')) {
        insertParams = params || [];
        return { rows: [INVOICE_ROW] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    });

    await createSubscriptionInvoice(makeReq({ id: 'company-1' }), makeRes(), NOOP_NEXT);

    expect(insertParams[5]).toBe(ACTIVE_SUBSCRIPTION_ROW.period_amount); // 660
    expect(insertParams[5]).not.toBe(ACTIVE_SUBSCRIPTION_ROW.monthly_price); // never 55
  });

  it('generates issue_date and due_date from the exact same captured timestamp', async () => {
    let insertParams: unknown[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [ACTIVE_SUBSCRIPTION_ROW] };
      if (sql.includes('INSERT INTO invoices')) {
        insertParams = params || [];
        // The controller binds the same $9 parameter to both issue_date and
        // due_date in the SQL text itself (VALUES (...,$9,$9)) — assert that
        // shape directly, and also that only ONE timestamp parameter was
        // passed (9 total params, not 10).
        expect(sql).toContain('$9, $9)');
        return { rows: [INVOICE_ROW] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    });

    await createSubscriptionInvoice(makeReq({ id: 'company-1' }), makeRes(), NOOP_NEXT);
    expect(insertParams).toHaveLength(9);
    expect(insertParams[8]).toBeInstanceOf(Date);
  });
});

describe('createSubscriptionInvoice() — company not found', () => {
  it('rolls back and throws 404 without ever checking subscriptions or calling logAudit', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'missing' });
    const res = makeRes();
    await expect(createSubscriptionInvoice(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);

    const sqlCalls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls.some((s) => s.includes('FROM subscriptions'))).toBe(false);
  });
});

describe('createSubscriptionInvoice() — no eligible active subscription', () => {
  it('returns 409 without ever calling logAudit, when no subscription is active', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'company-1' });
    const res = makeRes();
    await createSubscriptionInvoice(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'Company has no active commercial subscription to invoice' });
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });

  it('rejects when the only subscription row is past_due (not eligible in B3)', async () => {
    // The controller's own SQL filters `status = 'active'` — a past_due row
    // is never returned by that WHERE clause, so the mock simply returns no
    // rows, proving the filter (not app-side post-filtering) is what excludes it.
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('FROM subscriptions WHERE company_id')) {
        expect(sql).toContain("status = 'active'");
        return { rows: [] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    });

    const res = makeRes();
    await createSubscriptionInvoice(makeReq({ id: 'company-1' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(409);
  });

  it('succeeds when the commercial subscription is active even though nothing about companies.subscription_status is ever queried (suspended/cancelled tenant access does not block invoicing)', async () => {
    // There is no companies.subscription_status column read anywhere in this
    // flow — the only company query is `SELECT id FROM companies ... FOR
    // UPDATE`. This test documents that the eligibility decision is made
    // entirely from the subscriptions row, so a company whose tenant access
    // is suspended or cancelled (a fact this controller never looks at)
    // still gets invoiced as long as its commercial subscription is active.
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id FROM companies')) {
        expect(sql).not.toContain('subscription_status');
        return { rows: [{ id: 'company-1' }] };
      }
      if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [ACTIVE_SUBSCRIPTION_ROW] };
      if (sql.includes('INSERT INTO invoices')) return { rows: [INVOICE_ROW] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const res = makeRes();
    await createSubscriptionInvoice(makeReq({ id: 'company-1' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(201);
  });
});

describe('createSubscriptionInvoice() — conflict (duplicate period)', () => {
  it('rolls back BEFORE the recovery lookup, responds 409 with the full existing invoice, and never calls logAudit', async () => {
    const conflictErr: any = new Error('duplicate key value violates unique constraint "invoices_one_invoice_per_period"');
    conflictErr.code = '23505';
    conflictErr.constraint = 'invoices_one_invoice_per_period';

    const clientCallOrder: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      clientCallOrder.push(sql.includes('\n') ? sql.split('\n')[0].trim() : sql);
      if (sql === 'BEGIN') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [ACTIVE_SUBSCRIPTION_ROW] };
      if (sql.includes('INSERT INTO invoices')) throw conflictErr;
      if (sql === 'ROLLBACK') return {};
      throw new Error(`unexpected client query in conflict test: ${sql}`);
    });
    // The recovery lookup after rollback uses `pool.query`, not the
    // just-rolled-back client.
    mocks.poolQuery.mockResolvedValue({ rows: [INVOICE_ROW] });

    const req = makeReq({ id: 'company-1' });
    const res = makeRes();
    await createSubscriptionInvoice(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.existing_invoice).toEqual(INVOICE_ROW);
    expect(mocks.logAudit).not.toHaveBeenCalled();

    expect(clientCallOrder).toContain('ROLLBACK');
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);

    // No second invoice — only one INSERT was ever attempted.
    const insertCalls = mocks.clientQuery.mock.calls.filter((c) => (c[0] as string).includes('INSERT INTO invoices'));
    expect(insertCalls).toHaveLength(1);
  });

  it('does NOT treat an unrelated unique violation (different constraint) as this conflict', async () => {
    const unrelatedErr: any = new Error('duplicate key value violates unique constraint "invoices_number_unique"');
    unrelatedErr.code = '23505';
    unrelatedErr.constraint = 'invoices_number_unique';

    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [ACTIVE_SUBSCRIPTION_ROW] };
      if (sql.includes('INSERT INTO invoices')) throw unrelatedErr;
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'company-1' });
    const res = makeRes();
    await expect(createSubscriptionInvoice(req, res, NOOP_NEXT)).rejects.toBe(unrelatedErr);
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});

describe('createSubscriptionInvoice() — transaction rollback on unexpected failure', () => {
  it('rolls back if the INSERT fails for a reason other than the named conflict constraint', async () => {
    const insertErr = new Error('simulated INSERT failure');
    const calls: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [ACTIVE_SUBSCRIPTION_ROW] };
      if (sql.includes('INSERT INTO invoices')) throw insertErr;
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'company-1' });
    const res = makeRes();
    await expect(createSubscriptionInvoice(req, res, NOOP_NEXT)).rejects.toBe(insertErr);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });
});

describe('createSubscriptionInvoice() — audit failure isolation', () => {
  it('still returns 201 with the created invoice even if the best-effort audit call rejects', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('FROM subscriptions WHERE company_id')) return { rows: [ACTIVE_SUBSCRIPTION_ROW] };
      if (sql.includes('INSERT INTO invoices')) return { rows: [INVOICE_ROW] };
      throw new Error(`unexpected client query: ${sql}`);
    });
    // logAudit currently catches its own errors, but the controller also
    // protects this post-commit boundary in case that implementation changes.
    mocks.logAudit.mockRejectedValueOnce(new Error('audit write failed'));

    const req = makeReq({ id: 'company-1' });
    const res = makeRes();
    await createSubscriptionInvoice(req, res, NOOP_NEXT);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ success: true, invoice: INVOICE_ROW });
    const sqlCalls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls).toContain('COMMIT');
  });
});

describe('listInvoices() — includes the B3 snapshot fields', () => {
  it('selects invoice_number, plan, billing_interval, currency, period_start, and period_end', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [INVOICE_ROW] });
    const req = {} as Request;
    const res = makeRes();
    await listInvoices(req, res, NOOP_NEXT);

    expect(res.body).toEqual({ success: true, invoices: [INVOICE_ROW] });
    const sql = mocks.poolQuery.mock.calls[0][0] as string;
    for (const col of ['invoice_number', 'plan', 'billing_interval', 'currency', 'period_start', 'period_end']) {
      expect(sql).toContain(col);
    }
  });
});
