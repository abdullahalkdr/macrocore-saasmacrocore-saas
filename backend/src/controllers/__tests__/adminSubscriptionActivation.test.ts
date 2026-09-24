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
// Stage B7 — the B4A email helpers are mocked here only so the new
// post-commit ORDER test below can observe email vs. audit sequencing; every
// pre-existing test in this file keeps its behaviour (no recipients -> no
// email), exactly as before when recipient resolution silently failed.
vi.mock('../../utils/billingRecipients', () => ({ resolveBillingRecipients: mocks.resolveBillingRecipients }));
vi.mock('../../utils/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/email')>()),
  enqueueEmail: mocks.enqueueEmail,
}));

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
  mocks.resolveBillingRecipients.mockResolvedValue([]);
  mocks.enqueueEmail.mockResolvedValue({ jobId: 'job-1', deduped: false });
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
      // Chat 4C, Stage B4B — Layer A trial-lifecycle cancellation, now part
      // of this same transaction (design v8 §4.6).
      if (sql.includes('UPDATE email_jobs')) return { rows: [] };
      // Stage B7 — no open customer purchase for this company (design v3 §9.7).
      if (sql.includes('FROM subscription_purchases')) return { rows: [] };
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
      // Stage B7 — no open customer purchase for this company (design v3 §9.7).
      if (sql.includes('FROM subscription_purchases')) return { rows: [] };
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
      // Stage B7 — no open customer purchase for this company.
      if (sql.includes('FROM subscription_purchases')) return { rows: [] };
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
      // Stage B7 — no open customer purchase for this company (design v3 §9.7).
      if (sql.includes('FROM subscription_purchases')) return { rows: [] };
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
      // Stage B7 — no open customer purchase for this company (design v3 §9.7).
      if (sql.includes('FROM subscription_purchases')) return { rows: [] };
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


// ---------------------------------------------------------------------------
// Stage B7 — open customer purchase handling (design v3 §9.7 / R2, and the
// release-owner implementation clarification #1 on post-commit ordering).
// ---------------------------------------------------------------------------

const OPEN_PURCHASE_ROW = {
  id: 'purchase-1',
  company_id: 'company-1',
  subscription_id: 'pending-sub-1',
  invoice_id: 'pending-invoice-1',
  expires_at: '2026-09-24T10:00:00.000Z',
  target_plan: 'silver',
  target_interval: 'monthly',
};

function b7ActivationFlow(opts: { unexpired: boolean; insertError?: any; events?: string[] }) {
  const events = opts.events ?? [];
  mocks.clientQuery.mockImplementation(async (sql: string) => {
    const first = sql.trim().split('\n')[0].trim();
    events.push(first);
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
    if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
    if (sql.includes('FROM subscription_purchases sp')) return { rows: [OPEN_PURCHASE_ROW] };
    if (sql.includes('clock_timestamp() < expires_at AS unexpired')) return { rows: [{ unexpired: opts.unexpired }] };
    if (sql.includes('FROM subscription_purchases WHERE id = $1 FOR UPDATE')) {
      return { rows: [{ id: 'purchase-1', company_id: 'company-1', subscription_id: 'pending-sub-1', invoice_id: 'pending-invoice-1', status: 'open' }] };
    }
    if (sql.includes('SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 'pending-sub-1' }] };
    if (sql.includes('SELECT id, invoice_number, status FROM invoices')) {
      return { rows: [{ id: 'pending-invoice-1', invoice_number: 'MC-SUB-000042', status: 'issued' }] };
    }
    if (sql.includes('FROM payment_attempts WHERE invoice_id')) return { rows: [{ id: 'attempt-1', status: 'initiated' }] };
    if (sql.includes('FROM payment_checkout_sessions WHERE payment_attempt_id')) return { rows: [{ id: 'session-1', status: 'pending' }] };
    if (sql.includes('UPDATE payment_attempts SET status')) {
      return { rows: [{ id: 'attempt-1', status: 'cancelled', failed_at: null, succeeded_at: null, cancelled_at: '2026-09-24T10:05:00.000Z' }] };
    }
    if (sql.includes('UPDATE payment_checkout_sessions SET status')) {
      return { rows: [{ id: 'session-1', status: 'cancelled', resolved_at: '2026-09-24T10:05:00.000Z' }] };
    }
    if (sql.includes("UPDATE invoices SET status = 'void'")) return { rows: [{ id: 'pending-invoice-1' }] };
    if (sql.includes("UPDATE subscriptions SET status = 'abandoned'")) return { rows: [{ id: 'pending-sub-1' }] };
    if (sql.includes("UPDATE subscription_purchases SET status = 'void'")) return { rows: [{ id: 'purchase-1' }] };
    if (sql.includes('INSERT INTO subscriptions')) {
      if (opts.insertError) throw opts.insertError;
      return { rows: [SUBSCRIPTION_ROW] };
    }
    if (sql.includes('UPDATE companies')) return { rows: [] };
    if (sql.includes('UPDATE email_jobs')) return { rows: [] };
    throw new Error(`unexpected client query: ${sql}`);
  });
  return events;
}

describe('activateSubscription() — Stage B7 open customer purchase', () => {
  it('an UNEXPIRED open purchase blocks activation: 409 OPEN_CUSTOMER_PURCHASE, no insert, no company update, no void, no audit', async () => {
    const events = b7ActivationFlow({ unexpired: true });
    const res = makeRes();
    await activateSubscription(makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'annual', currency: 'USD', period_amount: 660 }), res, NOOP_NEXT);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'OPEN_CUSTOMER_PURCHASE', purchase_id: 'purchase-1', expires_at: OPEN_PURCHASE_ROW.expires_at });
    const sql = mocks.clientQuery.mock.calls.map((c) => String(c[0]));
    expect(sql.some((q) => q.includes('INSERT INTO subscriptions'))).toBe(false);
    expect(sql.some((q) => q.includes('UPDATE companies'))).toBe(false);
    expect(sql.some((q) => q.includes("SET status = 'void'"))).toBe(false);
    expect(events).toContain('ROLLBACK');
    expect(events).not.toContain('COMMIT');
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });

  it('the expiry decision is a separate clock_timestamp() statement issued AFTER the company and purchase locks (never now())', async () => {
    b7ActivationFlow({ unexpired: true });
    await activateSubscription(makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'annual', currency: 'USD', period_amount: 660 }), makeRes(), NOOP_NEXT);
    const sql = mocks.clientQuery.mock.calls.map((c) => String(c[0]));
    const companyLock = sql.findIndex((q) => q.includes('SELECT id FROM companies'));
    const purchaseLock = sql.findIndex((q) => q.includes('FROM subscription_purchases sp'));
    const clock = sql.findIndex((q) => q.includes('clock_timestamp() < expires_at'));
    expect(companyLock).toBeGreaterThan(0);
    expect(purchaseLock).toBeGreaterThan(companyLock);
    expect(sql[purchaseLock]).toContain('FOR UPDATE');
    expect(clock).toBeGreaterThan(purchaseLock);
    expect(sql[clock]).not.toMatch(/\bnow\(\)/);
  });

  it('an EXPIRED open purchase is voided in the same transaction (attempt/session cancel -> invoice void -> sub abandoned -> purchase void), then activation completes with one COMMIT', async () => {
    const events = b7ActivationFlow({ unexpired: false });
    const res = makeRes();
    await activateSubscription(makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'annual', currency: 'USD', period_amount: 660 }), res, NOOP_NEXT);

    expect(res.statusCode).toBe(201);
    const idx = (needle: string) => events.findIndex((e) => e.includes(needle));
    const order = [
      idx('UPDATE payment_attempts SET status'),
      idx('UPDATE payment_checkout_sessions SET status'),
      idx("UPDATE invoices SET status = 'void'"),
      idx("UPDATE subscriptions SET status = 'abandoned'"),
      idx("UPDATE subscription_purchases SET status = 'void'"),
      idx('INSERT INTO subscriptions'),
      idx('COMMIT'),
    ];
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(events.filter((e) => e === 'COMMIT')).toHaveLength(1);
    // settleOutcome wrote 'cancelled' (never failed/succeeded) for the open attempt.
    const attemptUpdate = mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE payment_attempts SET status'));
    expect(attemptUpdate?.[1]).toEqual(['attempt-1', 'cancelled']);
  });

  it('post-commit order is preserved: B4A activation email first, then the void audit, then admin_subscription_activated (release-owner clarification #1)', async () => {
    b7ActivationFlow({ unexpired: false });
    const post: string[] = [];
    mocks.resolveBillingRecipients.mockImplementation(async () => {
      post.push('resolveBillingRecipients');
      return [{ userId: 'user-1', email: 'owner@acme.example', preferredLanguage: 'ar', companyTimezone: 'Asia/Kuwait' }];
    });
    mocks.enqueueEmail.mockImplementation(async () => {
      post.push('enqueueEmail');
      return { jobId: 'job-1', deduped: false };
    });
    mocks.logAudit.mockImplementation(async (p: { action: string }) => {
      post.push(`audit:${p.action}`);
    });

    const res = makeRes();
    await activateSubscription(makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'annual', currency: 'USD', period_amount: 660 }), res, NOOP_NEXT);

    expect(res.statusCode).toBe(201);
    expect(post).toEqual([
      'resolveBillingRecipients',
      'enqueueEmail',
      'audit:subscription_purchase_voided',
      'audit:admin_subscription_activated',
    ]);
    const voidAudit = mocks.logAudit.mock.calls[0][0];
    expect(voidAudit).toMatchObject({
      companyId: 'company-1',
      userId: null,
      action: 'subscription_purchase_voided',
      entityType: 'subscription_purchases',
      entityId: 'purchase-1',
    });
    expect(voidAudit.newValues).toMatchObject({
      status: 'void',
      reason: 'expired_admin_action',
      admin_action: 'activate_subscription',
      invoice_id: 'pending-invoice-1',
      invoice_number: 'MC-SUB-000042',
      subscription_id: 'pending-sub-1',
      cancelled_payment_attempt_ids: ['attempt-1'],
    });
  });

  it('an EXPIRED purchase + an activation that then fails its own conflict check rolls back the void too (no COMMIT, no audit)', async () => {
    const conflictErr: any = new Error('duplicate key value violates unique constraint "subscriptions_one_live_per_company"');
    conflictErr.code = '23505';
    conflictErr.constraint = 'subscriptions_one_live_per_company';
    const events = b7ActivationFlow({ unexpired: false, insertError: conflictErr });
    mocks.poolQuery.mockResolvedValue({ rows: [SUBSCRIPTION_ROW] });

    const res = makeRes();
    await activateSubscription(makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'annual', currency: 'USD', period_amount: 660 }), res, NOOP_NEXT);

    expect(res.statusCode).toBe(409);
    expect(events).toContain("UPDATE subscription_purchases SET status = 'void' WHERE id = $1 AND status = 'open' RETURNING id");
    expect(events).toContain('ROLLBACK');
    expect(events).not.toContain('COMMIT');
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });
});
