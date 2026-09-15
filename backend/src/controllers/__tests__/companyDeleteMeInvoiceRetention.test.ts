import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Chat 4A / Stage B3 — company.controller.ts::deleteMe(), refactored to use
// one reserved client + one explicit transaction (mandatory correction, see
// claude/chat4a-b3-subscription-invoice-foundation-proposal-2026-09-15.md).
// Mocking shape mirrors adminSubscriptionActivation.test.ts exactly.
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
vi.mock('../../config/env', () => ({ env: { BYPASS_PLAN_GATING: false } }));

import { deleteMe } from '../company.controller';

const NOOP_NEXT = (() => {}) as any;

function makeRes(): Response & { statusCode?: number; body?: any } {
  const res: any = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
}

function makeReq(body: Record<string, unknown>, companyId = 'company-1', userId = 'user-1'): Request {
  return {
    body,
    ip: '10.0.0.1',
    headers: { 'user-agent': 'vitest' },
    auth: { companyId, userId },
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logAudit.mockResolvedValue(undefined);
});

describe('deleteMe() — success path (no invoices)', () => {
  it('locks the company row first, validates confirm_name, finds no invoices, deletes, and commits — a company with no invoices still deletes normally', async () => {
    const calls: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT name FROM companies')) return { rows: [{ name: 'Acme Co' }] };
      if (sql.includes('SELECT 1 FROM invoices')) return { rows: [] };
      if (sql.includes('DELETE FROM companies')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ confirm_name: 'Acme Co' });
    const res = makeRes();
    await deleteMe(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Company and all its data deleted' });
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);

    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 1]).toBe('COMMIT');

    // Lock order: the company row is locked FIRST (same order as
    // createSubscriptionInvoice's own company-row-first lock), so the two
    // endpoints can never deadlock against each other.
    expect(calls[1]).toContain('SELECT name FROM companies');
    expect(calls[1]).toContain('FOR UPDATE');

    const deleteIdx = calls.findIndex((s) => s.includes('DELETE FROM companies'));
    const invoiceCheckIdx = calls.findIndex((s) => s.includes('SELECT 1 FROM invoices'));
    expect(invoiceCheckIdx).toBeGreaterThan(0);
    expect(deleteIdx).toBeGreaterThan(invoiceCheckIdx);
  });

  it('never calls logAudit — the previous company_deleted call has been removed entirely, not just relocated', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('SELECT name FROM companies')) return { rows: [{ name: 'Acme Co' }] };
      if (sql.includes('SELECT 1 FROM invoices')) return { rows: [] };
      if (sql.includes('DELETE FROM companies')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    await deleteMe(makeReq({ confirm_name: 'Acme Co' }), makeRes(), NOOP_NEXT);
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});

describe('deleteMe() — company has issued invoices', () => {
  it('rolls back and returns 409 without deleting the company', async () => {
    const calls: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT name FROM companies')) return { rows: [{ name: 'Acme Co' }] };
      if (sql.includes('SELECT 1 FROM invoices')) return { rows: [{ '?column?': 1 }] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ confirm_name: 'Acme Co' });
    const res = makeRes();
    await expect(deleteMe(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 409 });

    expect(calls).toContain('ROLLBACK');
    expect(calls.some((s) => s.includes('DELETE FROM companies'))).toBe(false);
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });

  it('never produces a false successful-deletion response when invoices exist', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT name FROM companies')) return { rows: [{ name: 'Acme Co' }] };
      if (sql.includes('SELECT 1 FROM invoices')) return { rows: [{ '?column?': 1 }] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const res = makeRes();
    await expect(deleteMe(makeReq({ confirm_name: 'Acme Co' }), res, NOOP_NEXT)).rejects.toBeTruthy();
    // The response helpers were never called with a 200/success body — the
    // AppError propagates to asyncHandler's catch(next), so no success JSON
    // is ever written for this request.
    expect(res.status).not.toHaveBeenCalledWith(200);
  });
});

describe('deleteMe() — company not found', () => {
  it('rolls back and throws 404 without checking invoices or calling logAudit', async () => {
    const calls: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT name FROM companies')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ confirm_name: 'Anything' }, 'missing-company');
    const res = makeRes();
    await expect(deleteMe(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 404 });
    expect(calls.some((s) => s.includes('SELECT 1 FROM invoices'))).toBe(false);
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });
});

describe('deleteMe() — confirm_name mismatch', () => {
  it('rolls back and throws 400 without checking invoices, even when the company has none', async () => {
    const calls: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT name FROM companies')) return { rows: [{ name: 'Acme Co' }] };
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ confirm_name: 'Wrong Name' });
    const res = makeRes();
    await expect(deleteMe(req, res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 400 });
    expect(calls.some((s) => s.includes('SELECT 1 FROM invoices'))).toBe(false);
    expect(calls).toContain('ROLLBACK');
  });
});

describe('deleteMe() — transaction rollback on unexpected failure', () => {
  it('translates the invoice foreign-key backstop into the same clear 409', async () => {
    const fkErr = Object.assign(new Error('foreign key violation'), {
      code: '23503',
      constraint: 'invoices_company_id_fkey',
    });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT name FROM companies')) return { rows: [{ name: 'Acme Co' }] };
      if (sql.includes('SELECT 1 FROM invoices')) return { rows: [] };
      if (sql.includes('DELETE FROM companies')) throw fkErr;
      throw new Error(`unexpected client query: ${sql}`);
    });

    await expect(deleteMe(makeReq({ confirm_name: 'Acme Co' }), makeRes(), NOOP_NEXT)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Cannot delete a company with issued Macrocore invoices',
    });
  });

  it('rolls back if the DELETE itself fails after passing every check', async () => {
    const deleteErr = new Error('simulated DELETE failure');
    const calls: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('SELECT name FROM companies')) return { rows: [{ name: 'Acme Co' }] };
      if (sql.includes('SELECT 1 FROM invoices')) return { rows: [] };
      if (sql.includes('DELETE FROM companies')) throw deleteErr;
      throw new Error(`unexpected client query: ${sql}`);
    });

    const req = makeReq({ confirm_name: 'Acme Co' });
    const res = makeRes();
    await expect(deleteMe(req, res, NOOP_NEXT)).rejects.toBe(deleteErr);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
  });
});
