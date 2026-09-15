import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Chat 4A / Stage B1 — follow-up review round 2.
//
// adminUpdateCompanyAudit.test.ts (pure buildBillingAuditSnapshot() unit
// tests + source-inspection tests) stays as-is and still matters — this file
// adds what that one couldn't: actually EXECUTING updateCompany() end to end
// with a mocked pool/logAudit boundary (following the same real-vi.mock
// convention as supportTickets.helpdeskEmail.test.ts and
// utils/__tests__/helpdeskRecipients.test.ts), so the assertions are against
// real runtime behavior — the actual response JSON, the actual args passed to
// logAudit(), the actual error thrown — not just text that looks right.
//
// logAudit() itself is mocked in THIS file (its own real behavior, including
// what happens when its internal pool.query fails, is covered separately in
// adminUpdateCompanyAuditFailureIsolation.test.ts, which does NOT mock
// utils/audit so the real try/catch runs). Splitting into two files instead
// of toggling one mock mid-file matches this codebase's existing convention
// of one mock configuration per file (see supportTickets.accessControl vs
// supportTickets.helpdeskEmail).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: mocks.query } }));
vi.mock('../../utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('../../utils/audit', () => ({ logAudit: mocks.logAudit }));

import { updateCompany } from '../admin.controller';

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

function makeReq(params: Record<string, string>, body: Record<string, unknown>): Request {
  return {
    params,
    body,
    ip: '10.0.0.1',
    headers: { 'user-agent': 'vitest' },
  } as unknown as Request;
}

// The exact RETURNING row shape updateCompany's CTE query produces.
function updateRow(over: Record<string, unknown> = {}) {
  return {
    id: 'company-1',
    name: 'Acme Kiosk',
    plan: 'gold',
    subscription_status: 'active',
    trial_end_date: null,
    previous_plan: 'trial',
    previous_subscription_status: 'trial',
    previous_trial_end_date: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logAudit.mockResolvedValue(undefined);
});

describe('updateCompany() — successful update', () => {
  it('updates the company and logs a full, correctly-shaped audit call', async () => {
    mocks.query.mockResolvedValue({ rows: [updateRow()] });

    const req = makeReq({ id: 'company-1' }, { plan: 'gold', subscription_status: 'active' });
    const res = makeRes();
    await updateCompany(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    const call = mocks.logAudit.mock.calls[0][0];
    expect(call.companyId).toBe('company-1');
    expect(call.userId).toBeNull();
    expect(call.action).toBe('admin_company_billing_updated');
    expect(call.entityType).toBe('companies');
    expect(call.entityId).toBe('company-1');
    expect(call.oldValues).toEqual({ plan: 'trial', subscription_status: 'trial', trial_end_date: '2026-09-01T00:00:00.000Z' });
    expect(call.newValues).toEqual({ plan: 'gold', subscription_status: 'active', trial_end_date: null });
  });

  it('response body exposes only the public company fields — no previous_* leakage, no secrets', async () => {
    mocks.query.mockResolvedValue({ rows: [updateRow()] });

    const req = makeReq({ id: 'company-1' }, { plan: 'gold' });
    const res = makeRes();
    await updateCompany(req, res, NOOP_NEXT);

    expect(res.body).toEqual({
      success: true,
      company: { id: 'company-1', name: 'Acme Kiosk', plan: 'gold', subscription_status: 'active', trial_end_date: null },
    });
    expect(Object.keys(res.body.company).sort()).toEqual(['id', 'name', 'plan', 'subscription_status', 'trial_end_date']);
  });

  it('logs a genuine no-op PATCH (same value sent twice) rather than skipping it — with identical old/new snapshots', async () => {
    mocks.query.mockResolvedValue({
      rows: [
        updateRow({
          plan: 'gold',
          previous_plan: 'gold',
          subscription_status: 'active',
          previous_subscription_status: 'active',
          trial_end_date: null,
          previous_trial_end_date: null,
        }),
      ],
    });

    const req = makeReq({ id: 'company-1' }, { plan: 'gold' });
    const res = makeRes();
    await updateCompany(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    const { oldValues, newValues } = mocks.logAudit.mock.calls[0][0];
    expect(oldValues).toEqual(newValues);
  });
});

describe('updateCompany() — validation is rejected before any database write', () => {
  it('an invalid plan value throws 400 without ever calling pool.query', async () => {
    const req = makeReq({ id: 'company-1' }, { plan: 'not-a-real-plan' });
    const res = makeRes();
    await expect(updateCompany(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('an invalid subscription_status value throws 400 without ever calling pool.query', async () => {
    const req = makeReq({ id: 'company-1' }, { subscription_status: 'not-a-real-status' });
    const res = makeRes();
    await expect(updateCompany(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('an empty PATCH body throws 400 ("Nothing to update") without ever calling pool.query', async () => {
    const req = makeReq({ id: 'company-1' }, {});
    const res = makeRes();
    await expect(updateCompany(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe('updateCompany() — failure paths never produce a spurious audit row', () => {
  it('a missing company (empty RETURNING) throws 404 and never calls logAudit', async () => {
    mocks.query.mockResolvedValue({ rows: [] });

    const req = makeReq({ id: 'does-not-exist' }, { plan: 'gold' });
    const res = makeRes();
    await expect(updateCompany(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('a database error on the UPDATE propagates as-is and never calls logAudit', async () => {
    mocks.query.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const req = makeReq({ id: 'company-1' }, { plan: 'gold' });
    const res = makeRes();
    await expect(updateCompany(req, res, NOOP_NEXT)).rejects.toThrow('connection terminated unexpectedly');
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
