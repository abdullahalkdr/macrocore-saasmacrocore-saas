import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Chat 4A / Stage B1 — follow-up review round 2, item 1 (audit-INSERT-failure
// case) and item 2 (precise atomicity wording).
//
// Deliberately does NOT mock '../../utils/audit' — the REAL logAudit() runs
// here, with only its own pool.query call mocked to fail. This is the one
// case adminUpdateCompanyController.test.ts (where logAudit is fully mocked)
// cannot cover: proving the actual try/catch inside utils/audit.ts is what
// keeps a real audit_logs INSERT failure from reaching updateCompany's caller,
// not an assumption about it.
//
// The company lock/read/update is one transaction. The audit_logs INSERT is a
// separate best-effort statement after commit, so a failure here
// cannot undo it — but the request DOES wait for logAudit()'s promise to
// settle (success or caught failure) before responding; "isolated" here means
// isolated in OUTCOME (never changes the response or rolls back the UPDATE),
// not that it adds zero latency.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('../../db/pool', () => ({
  pool: { query: mocks.poolQuery, connect: mocks.connect },
}));
vi.mock('../../utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
// utils/whatsapp is untouched (real module) — harmless, since this action is
// not in SENSITIVE_ACTIONS so sendWhatsAppAlert() is never reached; it also
// only imports the same mocked db/pool, nothing env-dependent at import time.

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

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('updateCompany() + real logAudit() — audit_logs INSERT failure is fully isolated', () => {
  it('the companies UPDATE succeeds and the HTTP response is unaffected even though the subsequent audit INSERT throws', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('FROM companies WHERE id = $1 FOR UPDATE')) {
        return {
          rows: [
            {
              id: 'company-1',
              name: 'Acme Kiosk',
              plan: 'gold',
              subscription_status: 'active',
              trial_end_date: null,
            },
          ],
        };
      }
      if (sql.includes('SELECT EXISTS')) return { rows: [{ is_managed: false }] };
      if (sql.includes('UPDATE companies SET')) return { rows: [{ id: 'company-1', name: 'Acme Kiosk', plan: 'gold', subscription_status: 'active', trial_end_date: null }] };
      throw new Error(`unexpected query in test: ${sql}`);
    });
    mocks.poolQuery.mockRejectedValue(new Error('simulated audit_logs INSERT failure'));

    const req = makeReq({ id: 'company-1' }, { plan: 'gold', subscription_status: 'active' });
    const res = makeRes();

    // Must NOT throw/reject — this is the whole point of logAudit()'s own
    // try/catch, exercised for real here (not mocked away).
    await expect(updateCompany(req, res, NOOP_NEXT)).resolves.toBeUndefined();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      company: { id: 'company-1', name: 'Acme Kiosk', plan: 'gold', subscription_status: 'active', trial_end_date: null },
    });

    // Both statements were actually attempted, in this order — the UPDATE's
    // result was already read before the audit INSERT was ever issued.
    const sqlCalls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls[sqlCalls.length - 1]).toBe('COMMIT');
    expect(mocks.poolQuery).toHaveBeenCalledOnce();
    expect(mocks.clientRelease).toHaveBeenCalledOnce();

    // logAudit()'s own catch block logged the failure server-side instead of
    // silently discarding it or letting it propagate.
    expect(consoleErrorSpy).toHaveBeenCalledWith('audit log failed:', 'simulated audit_logs INSERT failure');
  });
});
