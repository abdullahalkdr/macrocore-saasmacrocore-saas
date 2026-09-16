import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// enqueueEmail.regression.test.ts — Chat 4C, Stage B4B (design v8 §5/§10/§11
// item 5). Proves the insertEmailJob() extraction (email.ts) left
// enqueueEmail()'s own external contract byte-identical for every
// pre-existing caller (register()'s trial_started email, activateSubscription()'s
// subscription_activated email, createSubscriptionInvoice()'s invoice_issued
// email — all of them call enqueueEmail(), never insertEmailJob() directly):
//   - the exact same INSERT SQL/params order as before the extraction,
//   - a real insert still fires attemptDeliverNow() exactly once,
//   - a deduped insert (ON CONFLICT DO NOTHING, no row returned) never fires
//     a delivery attempt at all, and instead looks up the existing job id.
//
// Uses a mocked `pool` (both `.query` and `.connect`) rather than a real
// database — same convention as invitations.test.ts/ticketSla.test.ts, this
// codebase's existing pattern for exercising a client-based flow without a
// live connection.
// ============================================================================

const { mockClient, mockPool } = vi.hoisted(() => {
  const mockClient = { query: vi.fn(), release: vi.fn() };
  const mockPool: { connect: any; query: any } = { connect: vi.fn(async () => mockClient), query: vi.fn() };
  return { mockClient, mockPool };
});

vi.mock('../../db/pool', () => ({ pool: mockPool }));

import { enqueueEmail } from '../email';

const NOW = new Date('2026-09-16T12:00:00.000Z');

function claimedJobRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'job-1',
    company_id: 'company-1',
    category: 'verification',
    dedup_key: 'verification:register:user:user-1',
    recipient_email: 'user@acme.example',
    lang: 'ar',
    subject: 'Verify',
    html: '<p>verify</p>',
    reply_to: null,
    related_entity_type: null,
    related_entity_id: null,
    status: 'processing',
    attempt_count: 1,
    max_attempts: 5,
    next_attempt_at: NOW.toISOString(),
    resend_message_id: null,
    last_error: null,
    last_attempted_at: NOW.toISOString(),
    sent_at: null,
    delivered_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.query.mockImplementation(async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return {};
    if (sql.includes('SELECT status FROM email_jobs')) return { rows: [{ status: 'processing' }] };
    if (sql.includes('UPDATE email_jobs')) return { rows: [] };
    throw new Error(`unexpected client query: ${sql}`);
  });
});

const INPUT = {
  to: 'user@acme.example',
  subject: 'Verify',
  html: '<p>verify</p>',
  category: 'verification' as const,
  lang: 'ar' as const,
  dedupKey: 'verification:register:user:user-1',
  companyId: 'company-1',
  relatedEntityType: null,
  relatedEntityId: null,
};

describe('enqueueEmail() — real insert path (regression)', () => {
  it('issues the exact same INSERT INTO email_jobs SQL/params order as before the insertEmailJob() extraction', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO email_jobs')) return { rows: [{ id: 'job-1' }] };
      if (sql.includes('UPDATE email_jobs')) return { rows: [claimedJobRow()] }; // claimJobById
      throw new Error(`unexpected pool query: ${sql}`);
    });

    const result = await enqueueEmail(INPUT);

    expect(result).toEqual({ jobId: 'job-1', deduped: false });
    const insertCall = mockPool.query.mock.calls.find((call: any[]) => String(call[0]).includes('INSERT INTO email_jobs'));
    expect(insertCall).toBeDefined();
    const [sql, params] = insertCall!;
    expect(sql).toContain('ON CONFLICT (dedup_key) DO NOTHING');
    expect(sql).toContain('RETURNING id');
    expect(params).toEqual([
      'company-1', // company_id
      'verification', // category
      'verification:register:user:user-1', // dedup_key
      'user@acme.example', // recipient_email (input.to)
      'ar', // lang
      'Verify', // subject
      '<p>verify</p>', // html
      'support@macrocore.io', // reply_to — resolveReplyTo('verification')
      null, // related_entity_type
      null, // related_entity_id
    ]);
  });

  it('a real insert still fires attemptDeliverNow() exactly once — observable via claimJobById() + the dev-mode finalize it triggers', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO email_jobs')) return { rows: [{ id: 'job-1' }] };
      if (sql.includes('UPDATE email_jobs') && sql.includes("status = 'processing'")) return { rows: [claimedJobRow()] };
      throw new Error(`unexpected pool query: ${sql}`);
    });

    await enqueueEmail(INPUT);
    // attemptDeliverNow() is fired-and-forgotten (`void attemptDeliverNow(...).catch(...)`)
    // — wait for its chain (claimJobById -> deliverClaimedJob -> deliverViaResend
    // -> finalizeJob) to actually run.
    await vi.waitFor(() => {
      expect(mockPool.query.mock.calls.some((call: any[]) => String(call[0]).includes("status = 'processing'"))).toBe(true);
    });
    // dev-mode fallback (no RESEND_API_KEY in the test environment, same as
    // every other test file in this codebase) — finalizeJob's UPDATE actually
    // ran, proving the delivery attempt reached its terminal state. Wait for
    // the UPDATE itself (not merely `connect()`), since connect() resolves
    // before the BEGIN/SELECT/UPDATE/COMMIT chain inside finalizeJob() has
    // had a chance to run.
    await vi.waitFor(() => {
      expect(mockClient.query.mock.calls.some((call: any[]) => String(call[0]).includes('UPDATE email_jobs'))).toBe(true);
    });
    expect(mockPool.connect).toHaveBeenCalledTimes(1);
    const finalizeUpdateCall = mockClient.query.mock.calls.find((call: any[]) => String(call[0]).includes('UPDATE email_jobs'));
    expect(finalizeUpdateCall).toBeDefined();
  });
});

describe('enqueueEmail() — deduped path (regression)', () => {
  it('a dedup (no row from the INSERT) never fires a delivery attempt, and looks up the existing job id instead', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO email_jobs')) return { rows: [] }; // ON CONFLICT DO NOTHING — no row
      if (sql.includes('SELECT id FROM email_jobs WHERE dedup_key')) return { rows: [{ id: 'existing-job-1' }] };
      throw new Error(`unexpected pool query: ${sql}`);
    });

    const result = await enqueueEmail(INPUT);

    expect(result).toEqual({ jobId: 'existing-job-1', deduped: true });
    // Give any stray fire-and-forget microtask a chance to run before asserting
    // it never happened.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockPool.connect).not.toHaveBeenCalled();
    expect(mockPool.query.mock.calls.some((call: any[]) => String(call[0]).includes("status = 'processing'"))).toBe(false);
  });
});

describe('enqueueEmail() — DB failure isolation (regression)', () => {
  it('never throws — a real DB error is swallowed, matching the pre-extraction contract', async () => {
    mockPool.query.mockRejectedValue(new Error('simulated DB error'));
    const result = await enqueueEmail(INPUT);
    expect(result).toEqual({ jobId: null, deduped: false });
  });
});
