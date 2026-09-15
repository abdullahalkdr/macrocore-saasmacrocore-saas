import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ============================================================================
// Chat 4B, Stage B4A — register() trial-started billing email wiring.
// Controller-level behavioral tests (real vi.mock()'d pool, real business
// logic run end to end), same convention as
// supportTickets.helpdeskEmail.test.ts and adminCreateSubscriptionInvoice.test.ts.
//
// Reviewed design (baseline fa379ff): the billing email is resolved and
// enqueued STRICTLY POST-COMMIT — resolveBillingRecipients and enqueueEmail
// are both mocked out here (their own behavior is covered by
// billingRecipients.test.ts and email.test.ts / billingEmail.test.ts), so
// this file only proves the WIRING: when register() calls them, with what
// arguments, and that a failure in either never affects the registration
// response.
//
// applyDepartmentTemplateByKey is mocked to a no-op — its own real SQL is out
// of scope for this stage and already covered elsewhere; mocking it keeps
// the client.query responder focused on exactly the statements B4A touches.
// ============================================================================

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  logAudit: vi.fn(),
  applyDepartmentTemplateByKey: vi.fn(),
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
vi.mock('../../utils/departmentTemplates', () => ({ applyDepartmentTemplateByKey: mocks.applyDepartmentTemplateByKey }));
vi.mock('../../utils/billingRecipients', () => ({ resolveBillingRecipients: mocks.resolveBillingRecipients }));
vi.mock('../../utils/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/email')>();
  return { ...actual, enqueueEmail: mocks.enqueueEmail };
});

import { register } from '../auth.controller';

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

function makeReq(body: Record<string, unknown>): Request {
  return { body, ip: '10.0.0.1', headers: { 'user-agent': 'vitest' } } as unknown as Request;
}

const COMPANY_ROW = {
  id: 'company-1',
  name: 'Al Salam Trading Co.',
  plan: 'trial',
  subscription_status: 'trial',
  trial_start_date: '2026-09-15T08:00:00.000Z',
  trial_end_date: '2026-09-29T08:00:00.000Z',
  industry: 'retail',
  employee_count_range: '2-5',
  country: 'KW',
  inventory_enabled: true,
};

const USER_ROW = {
  id: 'user-1',
  email: 'admin@acme.example',
  full_name: 'Admin Person',
  first_name: 'Admin',
  last_name: 'Person',
  job_title: null,
  phone: null,
  role: 'admin',
  company_id: 'company-1',
};

function validBody(over: Record<string, unknown> = {}) {
  return {
    email: 'admin@acme.example',
    password: 'password123',
    company_name: 'Al Salam Trading Co.',
    full_name: 'Admin Person',
    ...over,
  };
}

// register() also enqueues its own pre-existing verification email (category
// 'verification', fire-and-forget via `void enqueueEmail(...)`) on every
// successful registration — unrelated to this stage's billing wiring, and
// out of scope to change. These tests only care about the 'billing'-category
// calls, so every assertion below filters on that rather than counting
// mocks.enqueueEmail's calls directly.
function billingEnqueueCalls() {
  return mocks.enqueueEmail.mock.calls.map((c) => c[0]).filter((args) => args.category === 'billing');
}

function mockRegisterPool() {
  mocks.poolQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id FROM users WHERE email = $1')) return { rows: [] };
    throw new Error(`unexpected pool query in register() test: ${sql}`);
  });
  mocks.clientQuery.mockImplementation(async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
    if (sql.includes('INSERT INTO companies')) return { rows: [COMPANY_ROW] };
    if (sql.startsWith('INSERT INTO users')) return { rows: [USER_ROW] };
    if (sql.includes('INSERT INTO employees')) return { rows: [{ id: 'employee-1' }] };
    if (sql.startsWith('UPDATE users SET employee_id')) return { rows: [] };
    throw new Error(`unexpected client query in register() test: ${sql}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRegisterPool();
  mocks.logAudit.mockResolvedValue(undefined);
  mocks.applyDepartmentTemplateByKey.mockResolvedValue(undefined);
  mocks.resolveBillingRecipients.mockResolvedValue([]);
  mocks.enqueueEmail.mockResolvedValue({ jobId: 'job-1', deduped: false });
});

describe('register() — trial-started billing email, post-commit wiring', () => {
  it('resolves recipients and enqueues the trial-started email AFTER COMMIT, scoped to the real committed company id', async () => {
    mocks.resolveBillingRecipients.mockResolvedValue([
      { userId: 'user-1', email: 'admin@acme.example', preferredLanguage: 'en' },
    ]);

    const req = makeReq(validBody());
    const res = makeRes();
    await register(req, res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    expect(mocks.resolveBillingRecipients).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBillingRecipients).toHaveBeenCalledWith('company-1');

    // resolveBillingRecipients() (and therefore any email work) must be
    // called on the plain `pool` module import, never on the transaction's
    // own checked-out client — and must happen only after that client's
    // COMMIT was issued.
    const clientSqlCalls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(clientSqlCalls).toContain('COMMIT');
    expect(clientSqlCalls.some((s) => s.includes('email_jobs'))).toBe(false);

    const billingCalls = billingEnqueueCalls();
    expect(billingCalls).toHaveLength(1);
    const enqueueArgs = billingCalls[0];
    expect(enqueueArgs.to).toBe('admin@acme.example');
    expect(enqueueArgs.category).toBe('billing');
    expect(enqueueArgs.lang).toBe('en');
    expect(enqueueArgs.companyId).toBe('company-1');
    expect(enqueueArgs.relatedEntityType).toBe('companies');
    expect(enqueueArgs.relatedEntityId).toBe('company-1');
    // Brief's exact dedup-key format: event type + company ID + trial
    // lifecycle timestamp (the committed trial_start_date) + recipient user id.
    expect(enqueueArgs.dedupKey).toBe(
      `billing:trial_started:company-1:${new Date(COMPANY_ROW.trial_start_date).toISOString()}:user-1`
    );
  });

  it('never calls enqueueEmail() before the transaction COMMIT has been issued (call-order proof)', async () => {
    mocks.resolveBillingRecipients.mockResolvedValue([{ userId: 'user-1', email: 'admin@acme.example', preferredLanguage: 'en' }]);
    const callOrder: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      callOrder.push(`client:${sql.split('\n')[0].trim()}`);
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('INSERT INTO companies')) return { rows: [COMPANY_ROW] };
      if (sql.startsWith('INSERT INTO users')) return { rows: [USER_ROW] };
      if (sql.includes('INSERT INTO employees')) return { rows: [{ id: 'employee-1' }] };
      if (sql.startsWith('UPDATE users SET employee_id')) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });
    mocks.enqueueEmail.mockImplementation(async () => {
      callOrder.push('enqueueEmail');
      return { jobId: 'job-1', deduped: false };
    });

    await register(makeReq(validBody()), makeRes(), NOOP_NEXT);

    const commitIdx = callOrder.indexOf('client:COMMIT');
    const enqueueIdx = callOrder.indexOf('enqueueEmail');
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(enqueueIdx).toBeGreaterThan(commitIdx);
  });

  it('sends one job per resolved recipient, each with its own preferred language in the template', async () => {
    mocks.resolveBillingRecipients.mockResolvedValue([
      { userId: 'user-1', email: 'admin1@acme.example', preferredLanguage: 'en' },
      { userId: 'user-2', email: 'admin2@acme.example', preferredLanguage: 'ar' },
    ]);

    await register(makeReq(validBody()), makeRes(), NOOP_NEXT);

    const calls = billingEnqueueCalls();
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.to === 'admin1@acme.example').lang).toBe('en');
    expect(calls.find((c) => c.to === 'admin2@acme.example').lang).toBe('ar');
    expect(calls.find((c) => c.to === 'admin1@acme.example').dedupKey).not.toBe(
      calls.find((c) => c.to === 'admin2@acme.example').dedupKey
    );
  });

  it('enqueues zero billing emails when resolveBillingRecipients finds no active admin', async () => {
    mocks.resolveBillingRecipients.mockResolvedValue([]);
    const res = makeRes();
    await register(makeReq(validBody()), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(billingEnqueueCalls()).toHaveLength(0);
  });

  it('a recipient-resolution failure never fails registration, and enqueues nothing', async () => {
    mocks.resolveBillingRecipients.mockRejectedValue(new Error('resolver boom'));
    const res = makeRes();
    await register(makeReq(validBody()), res, NOOP_NEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(billingEnqueueCalls()).toHaveLength(0);
  });

  it('an enqueue failure for one recipient never blocks another recipient nor fails registration', async () => {
    mocks.resolveBillingRecipients.mockResolvedValue([
      { userId: 'user-1', email: 'fails@acme.example', preferredLanguage: 'en' },
      { userId: 'user-2', email: 'succeeds@acme.example', preferredLanguage: 'en' },
    ]);
    mocks.enqueueEmail.mockImplementation(async (input: { to: string }) => {
      if (input.to === 'fails@acme.example') throw new Error('enqueue boom');
      return { jobId: 'job-2', deduped: false };
    });

    const res = makeRes();
    await register(makeReq(validBody()), res, NOOP_NEXT);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(billingEnqueueCalls()).toHaveLength(2);
  });

  it('a registration that rolls back (duplicate email pre-check) never resolves recipients or enqueues an email', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM users WHERE email = $1')) return { rows: [{ id: 'existing-user' }] };
      throw new Error(`unexpected pool query: ${sql}`);
    });

    const res = makeRes();
    await expect(register(makeReq(validBody()), res, NOOP_NEXT)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.resolveBillingRecipients).not.toHaveBeenCalled();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
    // Never even reached client.connect()'s transaction.
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it('a registration that rolls back mid-transaction (employees INSERT fails) never resolves recipients or enqueues an email', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('INSERT INTO companies')) return { rows: [COMPANY_ROW] };
      if (sql.startsWith('INSERT INTO users')) return { rows: [USER_ROW] };
      if (sql.includes('INSERT INTO employees')) throw new Error('simulated employees insert failure');
      throw new Error(`unexpected client query: ${sql}`);
    });

    const res = makeRes();
    await expect(register(makeReq(validBody()), res, NOOP_NEXT)).rejects.toThrow('simulated employees insert failure');
    expect(mocks.resolveBillingRecipients).not.toHaveBeenCalled();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1);
    const sqlCalls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls).toContain('ROLLBACK');
    expect(sqlCalls).not.toContain('COMMIT');
  });

  it('the billing email link points at /account?section=billing', async () => {
    mocks.resolveBillingRecipients.mockResolvedValue([{ userId: 'user-1', email: 'admin@acme.example', preferredLanguage: 'en' }]);
    await register(makeReq(validBody()), makeRes(), NOOP_NEXT);
    const enqueueArgs = billingEnqueueCalls()[0];
    expect(enqueueArgs.html).toContain('/account?section=billing');
  });
});
