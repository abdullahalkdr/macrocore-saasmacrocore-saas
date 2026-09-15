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
    mockFlow();
    const res = makeRes();
    await updateCompany(makeReq({ plan: 'gold', subscription_status: 'active' }), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, company: { id: 'company-1', name: 'Acme Kiosk', plan: 'gold', subscription_status: 'active', trial_end_date: null } });
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1', userId: null, action: 'admin_company_billing_updated',
      entityType: 'companies', entityId: 'company-1',
      oldValues: { plan: 'trial', subscription_status: 'trial', trial_end_date: '2026-09-01T00:00:00.000Z' },
      newValues: { plan: 'gold', subscription_status: 'active', trial_end_date: null },
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
    await expect(updateCompany(makeReq({ plan: 'gold' }), makeRes(), NOOP_NEXT)).rejects.toBe(error);
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it('blocks a real plan change after the fresh managed check', async () => {
    mockFlow({ before: { ...BEFORE, plan: 'gold', subscription_status: 'active' }, managed: true });
    await expect(updateCompany(makeReq({ plan: 'bronze' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE companies SET'))).toBe(false);
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
    await updateCompany(makeReq({ plan: 'gold' }), makeRes(), NOOP_NEXT);
    const sql = mocks.clientQuery.mock.calls.map(([statement]) => String(statement));
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toContain('FOR UPDATE');
    expect(sql[2]).toContain('SELECT EXISTS');
    expect(sql[3]).toContain('UPDATE companies SET');
    expect(sql[4]).toBe('COMMIT');
  });
});
