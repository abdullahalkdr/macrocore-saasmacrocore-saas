import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Chat 4A / Stage B2 — mirrors
// adminUpdateCompanyAuditFailureIsolation.test.ts's convention exactly:
// deliberately does NOT mock '../../utils/audit' — the REAL logAudit() runs,
// with only its own internal pool.query call (a separate statement from the
// activation transaction, which uses pool.connect()) mocked to fail. Proves
// the real try/catch inside utils/audit.ts is what isolates a genuine
// audit_logs INSERT failure here, not an assumption about it.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  resolveBillingRecipients: vi.fn(),
}));

vi.mock('../../db/pool', () => ({
  pool: {
    query: mocks.poolQuery, // used only by the REAL logAudit()'s internal INSERT
    connect: vi.fn(async () => ({ query: mocks.clientQuery, release: mocks.clientRelease })),
  },
}));
vi.mock('../../utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
// Chat 4B / Stage B4A added a post-commit billing-email block to
// activateSubscription() that is out of scope for this file (its own
// dedicated coverage lives in adminActivateSubscriptionBillingEmail.test.ts)
// — mocked out here to a no-recipients no-op so it never touches the same
// mocked `pool.query` this test uses to simulate the audit_logs INSERT
// failure, keeping this file's "one pool.query call" assertion meaningful.
vi.mock('../../utils/billingRecipients', () => ({ resolveBillingRecipients: mocks.resolveBillingRecipients }));
// utils/whatsapp untouched (real module) — harmless, since
// 'admin_subscription_activated' is not in SENSITIVE_ACTIONS, so
// sendWhatsAppAlert() is never reached.

import { activateSubscription } from '../admin.controller';

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
  id: 'sub-1', company_id: 'company-1', plan: 'gold', status: 'active', currency: 'USD',
  period_amount: 660, monthly_price: 55, billing_interval: 'annual',
  current_period_start: '2026-09-15T00:00:00.000Z', current_period_end: '2027-09-15T00:00:00.000Z',
  auto_renew: false, created_at: '2026-09-15T00:00:00.000Z',
};

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.resolveBillingRecipients.mockResolvedValue([]);
});
afterEach(() => consoleErrorSpy.mockRestore());

describe('activateSubscription() + real logAudit() — audit_logs INSERT failure is fully isolated', () => {
  it('the transaction already committed and the 201 response is unaffected even though the subsequent audit INSERT throws', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT id FROM companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('INSERT INTO subscriptions')) return { rows: [SUBSCRIPTION_ROW] };
      if (sql.includes('UPDATE companies')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });
    // The real logAudit()'s own internal pool.query (the audit_logs INSERT)
    // fails — its own try/catch (utils/audit.ts) must swallow this.
    mocks.poolQuery.mockRejectedValue(new Error('simulated audit_logs INSERT failure'));

    const req = makeReq({ id: 'company-1' }, { plan: 'gold', billing_interval: 'annual', currency: 'USD', period_amount: 660 });
    const res = makeRes();

    await expect(activateSubscription(req, res, NOOP_NEXT)).resolves.toBeUndefined();

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.subscription).toEqual(SUBSCRIPTION_ROW);

    // The transaction (client.query calls) fully committed before the audit
    // INSERT (pool.query, a separate connection) was ever attempted.
    const clientSqlCalls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(clientSqlCalls[clientSqlCalls.length - 1]).toBe('COMMIT');
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);

    expect(consoleErrorSpy).toHaveBeenCalledWith('audit log failed:', 'simulated audit_logs INSERT failure');
  });
});
