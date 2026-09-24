import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(), clientRelease: vi.fn(), connect: vi.fn(), logAudit: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: vi.fn(), connect: mocks.connect } }));
vi.mock('../../utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('../../utils/audit', () => ({ logAudit: mocks.logAudit }));

import { updateCompany } from '../admin.controller';

const NOOP_NEXT = (() => {}) as any;
function makeRes(): Response & { statusCode?: number; body?: any } {
  const res: any = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
}
function makeReq(body: Record<string, unknown>, id = 'company-1'): Request {
  return { params: { id }, body, ip: '10.0.0.1', headers: { 'user-agent': 'vitest' } } as unknown as Request;
}

const BEFORE = {
  id: 'company-1', name: 'Acme Kiosk', plan: 'trial', subscription_status: 'trial',
  trial_end_date: '2026-09-01T00:00:00.000Z',
};

function mockFlow(options: {
  before?: Record<string, unknown> | null;
  managed?: boolean;
  after?: Record<string, unknown>;
  updateError?: Error;
} = {}) {
  const before = options.before === undefined ? BEFORE : options.before;
  const after = options.after ?? { ...BEFORE, plan: 'gold', subscription_status: 'active', trial_end_date: null };
  mocks.clientQuery.mockImplementation(async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
    if (sql.includes('FROM companies WHERE id = $1 FOR UPDATE')) return { rows: before ? [before] : [] };
    if (sql.includes('SELECT EXISTS')) return { rows: [{ is_managed: options.managed ?? false }] };
    if (sql.includes('UPDATE companies SET')) {
      if (options.updateError) throw options.updateError;
      return { rows: [after] };
    }
    // Stage B7 — no open customer purchase for this company (design v3 §9.7).
    if (sql.includes('FROM subscription_purchases')) return { rows: [] };
    throw new Error(`unexpected client query: ${sql}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  mocks.logAudit.mockResolvedValue(undefined);
});

describe('updateCompany()', () => {
  it('updates and logs the same narrow before/after snapshot B1 established', async () => {
    // Was plan 'trial'->'gold' — now blocked by the 2026-09-15 paid-plan
    // guard (see the dedicated tests below), so this snapshot test instead
    // exercises a downgrade/cancel (still a real, allowed 3-field diff):
    // plan 'gold'->'trial', status 'active'->'cancelled'.
    const before = { ...BEFORE, plan: 'gold', subscription_status: 'active' };
    const after = { ...before, plan: 'trial', subscription_status: 'cancelled', trial_end_date: null };
    mockFlow({ before, after });
    const res = makeRes();
    await updateCompany(makeReq({ plan: 'trial', subscription_status: 'cancelled', trial_end_date: null }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, company: { id: 'company-1', name: 'Acme Kiosk', plan: 'trial', subscription_status: 'cancelled', trial_end_date: null } });
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1', userId: null, action: 'admin_company_billing_updated',
      entityType: 'companies', entityId: 'company-1',
      oldValues: { plan: 'gold', subscription_status: 'active', trial_end_date: before.trial_end_date },
      newValues: { plan: 'trial', subscription_status: 'cancelled', trial_end_date: null },
    }));
    expect(mocks.clientRelease).toHaveBeenCalledOnce();
  });

  it('logs an allowed no-op with identical snapshots', async () => {
    const unchanged = { ...BEFORE, plan: 'gold', subscription_status: 'active', trial_end_date: null };
    mockFlow({ before: unchanged, after: unchanged });
    await updateCompany(makeReq({ plan: 'gold' }), makeRes(), NOOP_NEXT);
    const audit = mocks.logAudit.mock.calls[0][0];
    expect(audit.oldValues).toEqual(audit.newValues);
  });

  it.each([
    [{ plan: 'not-a-real-plan' }, /plan/],
    [{ subscription_status: 'not-a-real-status' }, /subscription_status/],
    [{}, /Nothing to update/],
  ])('rejects invalid input before checking out a database client', async (body, message) => {
    await expect(updateCompany(makeReq(body), makeRes(), NOOP_NEXT)).rejects.toThrow(message);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('rolls back and returns 404 when the company does not exist', async () => {
    mockFlow({ before: null });
    await expect(updateCompany(makeReq({ plan: 'gold' }, 'missing'), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('rolls back a database failure and never writes an audit row', async () => {
    const error = new Error('connection terminated unexpectedly');
    mockFlow({ updateError: error });
    // subscription_status only (no plan) — reaches the real UPDATE statement
    // without tripping the paid-plan guard below, so this still isolates the
    // DB-failure/rollback path it's meant to test.
    await expect(updateCompany(makeReq({ subscription_status: 'active' }), makeRes(), NOOP_NEXT)).rejects.toBe(error);
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('blocks a real plan change after the fresh managed check', async () => {
    mockFlow({ before: { ...BEFORE, plan: 'gold', subscription_status: 'active' }, managed: true });
    await expect(updateCompany(makeReq({ plan: 'bronze' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE companies SET'))).toBe(false);
  });

  // 2026-09-15 decision (see admin.controller.ts's updateCompany() guard
  // comment): a real paid plan (bronze/silver/gold/enterprise) can only be
  // granted via Activate Subscription — it creates the subscriptions row
  // invoicing/MRR/billing-emails all depend on. This endpoint previously
  // only blocked a plan change on an ALREADY-managed company; it now blocks
  // any non-trial plan change regardless of managed state, closing the gap
  // where an unmanaged company could be granted paid-tier feature access
  // (companies.plan gates requirePlanLevel directly) with no subscriptions
  // row at all — see claude/chat4b-b4a-post-commit-implementation-2026-09-15.md.
  describe('paid-plan guard (2026-09-15)', () => {
    it('blocks a real paid-plan change even when the company is NOT (yet) managed', async () => {
      mockFlow({ managed: false }); // BEFORE.plan = 'trial'
      await expect(updateCompany(makeReq({ plan: 'gold' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 409 });
      expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE companies SET'))).toBe(false);
    });

    it('still allows moving an unmanaged company TO trial — a downgrade/reset, not a paid grant', async () => {
      const before = { ...BEFORE, plan: 'bronze', subscription_status: 'active' };
      mockFlow({ before, managed: false, after: { ...before, plan: 'trial' } });
      const res = makeRes();
      await updateCompany(makeReq({ plan: 'trial' }), res, NOOP_NEXT);
      expect(res.statusCode).toBe(200);
    });

    it('still allows re-saving the current plan value unchanged — the admin UI always resends it on every Save', async () => {
      const before = { ...BEFORE, plan: 'gold', subscription_status: 'active' };
      mockFlow({ before, managed: false, after: { ...before, subscription_status: 'suspended' } });
      const res = makeRes();
      await updateCompany(makeReq({ plan: 'gold', subscription_status: 'suspended' }), res, NOOP_NEXT);
      expect(res.statusCode).toBe(200);
    });
  });

  it('allows the existing admin UI payload to change status when plan is unchanged', async () => {
    const before = { ...BEFORE, plan: 'gold', subscription_status: 'active', trial_end_date: null };
    mockFlow({ before, managed: true, after: { ...before, subscription_status: 'suspended' } });
    const res = makeRes();
    await updateCompany(makeReq({ plan: 'gold', subscription_status: 'suspended', trial_end_date: null }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
  });

  it("blocks trial but allows cancelled on a managed company", async () => {
    const before = { ...BEFORE, plan: 'gold', subscription_status: 'active' };
    mockFlow({ before, managed: true });
    await expect(updateCompany(makeReq({ subscription_status: 'trial' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 409 });

    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
    mocks.logAudit.mockResolvedValue(undefined);
    mockFlow({ before, managed: true, after: { ...before, subscription_status: 'cancelled' } });
    const res = makeRes();
    await updateCompany(makeReq({ subscription_status: 'cancelled' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
  });

  it('locks first, refreshes managed state second, then updates and commits', async () => {
    mockFlow();
    // subscription_status only (no plan) — same statement-order guarantee,
    // without tripping the paid-plan guard tested separately above.
    await updateCompany(makeReq({ subscription_status: 'active' }), makeRes(), NOOP_NEXT);
    const sql = mocks.clientQuery.mock.calls.map(([statement]) => String(statement));
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toContain('FOR UPDATE');
    // Stage B7 (design v3 §9.7): a status change first looks for an open
    // customer purchase under the company lock (none here).
    expect(sql[2]).toContain('FROM subscription_purchases');
    expect(sql[3]).toContain('SELECT EXISTS');
    expect(sql[4]).toContain('UPDATE companies SET');
    expect(sql[5]).toBe('COMMIT');
  });
});

// ---------------------------------------------------------------------------
// Stage B7 — open customer purchase handling on updateCompany (design v3
// §9.7, A5 + R2). No activation email exists on this path, so the expired
// purchase void audit simply precedes the existing company audit.
// ---------------------------------------------------------------------------

function b7UpdateFlow(opts: { unexpired: boolean; managed?: boolean; before?: Record<string, unknown>; after?: Record<string, unknown> }) {
  const before = opts.before ?? BEFORE;
  const after = opts.after ?? { ...before, subscription_status: 'suspended' };
  const events: string[] = [];
  mocks.clientQuery.mockImplementation(async (sql: string) => {
    events.push(sql.trim().split('\n')[0].trim());
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
    if (sql.includes('FROM companies WHERE id = $1 FOR UPDATE')) return { rows: [before] };
    if (sql.includes('FROM subscription_purchases sp')) {
      return {
        rows: [{ id: 'purchase-1', company_id: 'company-1', subscription_id: 'pending-sub-1', invoice_id: 'pending-invoice-1',
          expires_at: '2026-09-24T10:00:00.000Z', target_plan: 'gold', target_interval: 'annual' }],
      };
    }
    if (sql.includes('clock_timestamp() < expires_at AS unexpired')) return { rows: [{ unexpired: opts.unexpired }] };
    if (sql.includes('FROM subscription_purchases WHERE id = $1 FOR UPDATE')) {
      return { rows: [{ id: 'purchase-1', company_id: 'company-1', subscription_id: 'pending-sub-1', invoice_id: 'pending-invoice-1', status: 'open' }] };
    }
    if (sql.includes('SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 'pending-sub-1' }] };
    if (sql.includes('SELECT id, invoice_number, status FROM invoices')) {
      return { rows: [{ id: 'pending-invoice-1', invoice_number: 'MC-SUB-000077', status: 'issued' }] };
    }
    if (sql.includes('FROM payment_attempts WHERE invoice_id')) return { rows: [] };
    if (sql.includes("UPDATE invoices SET status = 'void'")) return { rows: [{ id: 'pending-invoice-1' }] };
    if (sql.includes("UPDATE subscriptions SET status = 'abandoned'")) return { rows: [{ id: 'pending-sub-1' }] };
    if (sql.includes("UPDATE subscription_purchases SET status = 'void'")) return { rows: [{ id: 'purchase-1' }] };
    if (sql.includes('SELECT EXISTS')) return { rows: [{ is_managed: opts.managed ?? false }] };
    if (sql.includes('UPDATE companies SET')) return { rows: [after] };
    throw new Error(`unexpected client query: ${sql}`);
  });
  return events;
}

describe('updateCompany() — Stage B7 open customer purchase', () => {
  it('an UNEXPIRED open purchase blocks a subscription_status change: 409 OPEN_CUSTOMER_PURCHASE, no UPDATE, no void, no audit', async () => {
    const events = b7UpdateFlow({ unexpired: true });
    const res = makeRes();
    await updateCompany(makeReq({ subscription_status: 'suspended' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'OPEN_CUSTOMER_PURCHASE', purchase_id: 'purchase-1' });
    expect(events.some((e) => e.includes('UPDATE companies SET'))).toBe(false);
    expect(events.some((e) => e.includes("SET status = 'void'"))).toBe(false);
    expect(events).toContain('ROLLBACK');
    expect(events).not.toContain('COMMIT');
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });

  it('an EXPIRED open purchase is voided, then the PATCH continues in the same transaction; void audit precedes the company audit', async () => {
    const events = b7UpdateFlow({ unexpired: false });
    const res = makeRes();
    await updateCompany(makeReq({ subscription_status: 'suspended' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    const voidAt = events.findIndex((e) => e.includes("UPDATE subscription_purchases SET status = 'void'"));
    const updateAt = events.findIndex((e) => e.includes('UPDATE companies SET'));
    expect(voidAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(voidAt);
    expect(events.filter((e) => e === 'COMMIT')).toHaveLength(1);
    expect(mocks.logAudit.mock.calls.map((c) => c[0].action)).toEqual([
      'subscription_purchase_voided',
      'admin_company_billing_updated',
    ]);
    expect(mocks.logAudit.mock.calls[0][0].newValues).toMatchObject({
      reason: 'expired_admin_action',
      admin_action: 'update_company',
      invoice_number: 'MC-SUB-000077',
    });
  });

  it('an EXPIRED purchase + a PATCH that then fails its own managed-subscription rule rolls the void back too', async () => {
    // Managed + subscription_status 'trial' is rejected by the existing rule.
    const events = b7UpdateFlow({ unexpired: false, managed: true, before: { ...BEFORE, subscription_status: 'suspended' } });
    await expect(updateCompany(makeReq({ subscription_status: 'trial' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 409 });
    expect(events.some((e) => e.includes("UPDATE subscription_purchases SET status = 'void'"))).toBe(true);
    expect(events).toContain('ROLLBACK');
    expect(events).not.toContain('COMMIT');
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('a trial_end_date-only PATCH never looks at customer purchases', async () => {
    const events = b7UpdateFlow({ unexpired: true, after: { ...BEFORE, trial_end_date: '2026-10-01T00:00:00.000Z' } });
    const res = makeRes();
    await updateCompany(makeReq({ trial_end_date: '2026-10-01T00:00:00.000Z' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(events.some((e) => e.includes('subscription_purchases'))).toBe(false);
  });

  it('re-saving the unchanged plan/status values (the admin UI always resends them) never looks at customer purchases', async () => {
    const events = b7UpdateFlow({ unexpired: true, after: BEFORE });
    const res = makeRes();
    await updateCompany(makeReq({ plan: 'trial', subscription_status: 'trial' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(events.some((e) => e.includes('subscription_purchases'))).toBe(false);
  });
});
