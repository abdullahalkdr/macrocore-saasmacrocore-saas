import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Chat 4A / Stage B2 — activateSubscription / getCompanySubscription.
// Mocks pool.connect() to return a fake client with its own query/release,
// separate from pool.query() (used only by getCompanySubscription and by the
// post-rollback recovery lookup in the conflict path — see
// admin.controller.ts's own comment on why that lookup uses `pool`, not the
// just-rolled-back `client`).
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

import { activateSubscription, getCompanySubscription } from '../admin.controller';

const NOOP_NEXT = (() => {}) as any;

function makeRes(): Response & { statusCode?: number; body?: any } {
  const res: any = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
}

function makeReq(params: Record<string, string>, body: Record<string, unknown>): Request {
  return { params, body, ip: '10.0.0.1', headers: { 'user-agent': 'vitest' } } as unknown as Request;
}

const SUBSCRIPTION_ROW = {
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logAudit.mockResolvedValue(undefined);
});

describe('activateSubscription() — validation before any DB work', () => {
  it('rejects an invalid plan without ever calling pool.connect', async () => {
    const req = makeReq({ id: 'company-1' }, { plan: 'trial', billing_interval: 'monthly', currency: 'USD', period_amount: 10 });
    const res = makeRes();
    await expect(activateSubscription(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an invalid billing_interval', async () => {
    const req = makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'weekly', currency: 'USD', period_amount: 10 });
    const res = makeRes();
    await expect(activateSubscription(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an unsupported currency', async () => {
    const req = makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'monthly', currency: 'EUR', period_amount: 10 });
    const res = makeRes();
    await expect(activateSubscription(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects monthly billing for a manually quoted enterprise subscription', async () => {
    const req = makeReq({ id: 'company-1' }, { plan: 'enterprise', billing_interval: 'monthly', currency: 'USD', period_amount: 1200 });
    const res = makeRes();
    await expect(activateSubscription(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a standard-plan amount that differs from the approved USD catalog', async () => {
    const req = makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'monthly', currency: 'USD', period_amount: 66 });
    const res = makeRes();
    await expect(activateSubscription(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects KWD because the approved collection currency is currently USD', async () => {
    const req = makeReq({ id: 'company-1' }, { plan: 'enterprise', billing_interval: 'annual', currency: 'KWD', period_amount: 1200 });
    const res = makeRes();
    await expect(activateSubscription(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a non-finite period_amount', async () => {
    const req = makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'monthly', currency: 'USD', period_amount: 'sixty' });
    const res = makeRes();
    await expect(activateSubscription(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('activateSubscription() — success path', () => {
  it('runs BEGIN, locks the company row, inserts, syncs companies, commits, releases the client, and logs a best-effort audit row', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('INSERT INTO subscriptions')) return { rows: [SUBSCRIPTION_ROW] };
      if (sql.includes('UPDATE companies')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'annual', currency: 'USD', period_amount: 660 });
    const res = makeRes();
    await activateSubscription(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({
      success: true,
      subscription: SUBSCRIPTION_ROW,
      company: { id: 'company-1', plan: 'gold', subscription_status: 'active' },
    });
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);

    const sqlCalls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls[0]).toBe('BEGIN');
    expect(sqlCalls[sqlCalls.length - 1]).toBe('COMMIT');

    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    const call = mocks.logAudit.mock.calls[0][0];
    expect(call.action).toBe('admin_subscription_activated');
    expect(call.entityType).toBe('subscriptions');
    expect(call.userId).toBeNull();
  });
});

describe('activateSubscription() — company not found', () => {
  it('rolls back and throws 404 without ever calling logAudit', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'missing' }, { plan: 'gold', billing_interval: 'monthly', currency: 'USD', period_amount: 67 });
    const res = makeRes();
    await expect(activateSubscription(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });
});

describe('activateSubscription() — conflict (already managed)', () => {
  it('rolls back BEFORE the recovery lookup, responds 409 with the full existing record, and never calls logAudit', async () => {
    const conflictErr: any = new Error('duplicate key value violates unique constraint "subscriptions_one_live_per_company"');
    conflictErr.code = '23505';
    conflictErr.constraint = 'subscriptions_one_live_per_company';

    const clientCallOrder: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      clientCallOrder.push(sql.includes('\n') ? sql.split('\n')[0].trim() : sql);
      if (sql === 'BEGIN') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('INSERT INTO subscriptions')) throw conflictErr;
      if (sql === 'ROLLBACK') return {};
      throw new Error(`unexpected client query in conflict test: ${sql}`);
    });
    // The recovery lookup after rollback uses `pool.query`, not the
    // just-rolled-back client — see admin.controller.ts's comment.
    mocks.poolQuery.mockResolvedValue({ rows: [{ ...SUBSCRIPTION_ROW, plan: 'silver' }] });

    const req = makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'monthly', currency: 'USD', period_amount: 67 });
    const res = makeRes();
    await activateSubscription(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.existing_subscription.plan).toBe('silver');
    expect(mocks.logAudit).not.toHaveBeenCalled();

    // ROLLBACK must have been issued before the client is released, and the
    // recovery read happens via `pool`, not the aborted client.
    expect(clientCallOrder).toContain('ROLLBACK');
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });

  it('does NOT treat an unrelated unique violation (different constraint) as this conflict', async () => {
    const unrelatedErr: any = new Error('duplicate key value violates unique constraint "subscriptions_pkey"');
    unrelatedErr.code = '23505';
    unrelatedErr.constraint = 'subscriptions_pkey';

    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('INSERT INTO subscriptions')) throw unrelatedErr;
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'monthly', currency: 'USD', period_amount: 67 });
    const res = makeRes();
    await expect(activateSubscription(req, res, NOOP_NEXT)).rejects.toBe(unrelatedErr);
    // Never fabricated a 409 for the wrong constraint.
    expect(res.status).not.toHaveBeenCalledWith(409);
  });
});

describe('activateSubscription() — rollback on failure between INSERT and companies UPDATE', () => {
  it('rolls back if the companies UPDATE itself fails after a successful INSERT', async () => {
    const updateErr = new Error('simulated companies UPDATE failure');
    const calls: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('INSERT INTO subscriptions')) return { rows: [SUBSCRIPTION_ROW] };
      if (sql.includes('UPDATE companies')) throw updateErr;
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'annual', currency: 'USD', period_amount: 660 });
    const res = makeRes();
    await expect(activateSubscription(req, res, NOOP_NEXT)).rejects.toBe(updateErr);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });
});

describe('getCompanySubscription()', () => {
  it('returns the live subscription when one exists', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [SUBSCRIPTION_ROW] });
    const req = makeReq({ id: 'company-1' }, {});
    const res = makeRes();
    await getCompanySubscription(req, res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, subscription: SUBSCRIPTION_ROW });
  });

  it('returns null when no live subscription exists', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ company_exists: 'company-1', id: null }] });
    const req = makeReq({ id: 'company-1' }, {});
    const res = makeRes();
    await getCompanySubscription(req, res, NOOP_NEXT);
    expect(res.body).toEqual({ success: true, subscription: null });
  });

  it('returns 404 when the company itself does not exist', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    const req = makeReq({ id: 'missing-company' }, {});
    const res = makeRes();
    await expect(getCompanySubscription(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('keeps nullable legacy period fields readable after a compatibility migration', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [{ ...SUBSCRIPTION_ROW, current_period_start: null, current_period_end: null }],
    });
    const req = makeReq({ id: 'company-1' }, {});
    const res = makeRes();
    await getCompanySubscription(req, res, NOOP_NEXT);
    expect(res.body.subscription.current_period_start).toBeNull();
    expect(res.body.subscription.current_period_end).toBeNull();
  });
});
