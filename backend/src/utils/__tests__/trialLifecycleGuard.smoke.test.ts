import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// trialLifecycleGuard.smoke.test.ts — Chat 4C, Stage B4B (design v8 §4/§10/§11).
// Disposable-Postgres smoke test: the attempt-budget-neutral deferral
// (five-cycle neutrality vs. a genuine attempt NOT being neutralized),
// NOWAIT contention with real timing, the corrected Order-A/Order-B race
// scenarios (§4.7), event-specific temporal staleness (§4.2, including the
// extension/marker-mismatch case), and Layer A's starts_with() exactness
// against trial_started (§4.6).
//
// Skipped entirely unless B4B_SMOKE_DATABASE_URL is set — see
// trialLifecycleEmails.smoke.test.ts's own header for the full reasoning.
// ============================================================================

const SMOKE_DB_URL = process.env.B4B_SMOKE_DATABASE_URL;

const { testPool } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PoolCtor } = require('pg');
  return {
    testPool: new PoolCtor({ connectionString: process.env.B4B_SMOKE_DATABASE_URL || 'postgres://unused:unused@127.0.0.1:1/unused' }) as Pool,
  };
});
vi.mock('../../db/pool', () => ({ pool: testPool }));

import { deliverTrialLifecycleJob, isLockNotAvailable, isTrialLifecycleJob, type EmailJobRow } from '../email';

describe('isLockNotAvailable() / isTrialLifecycleJob() — pure unit checks', () => {
  it('isLockNotAvailable recognizes 55P03 only', () => {
    expect(isLockNotAvailable({ code: '55P03' })).toBe(true);
    expect(isLockNotAvailable({ code: '40P01' })).toBe(false);
    expect(isLockNotAvailable(new Error('boom'))).toBe(false);
    expect(isLockNotAvailable(null)).toBe(false);
  });

  it('isTrialLifecycleJob requires category=billing, related_entity_type=companies, AND one of the two prefixes', () => {
    const base: EmailJobRow = {
      id: 'job-1',
      company_id: 'company-1',
      category: 'billing',
      dedup_key: 'billing:trial_ending:company-1:2026-09-16T00:00:00.000000Z:user-1',
      recipient_email: 'a@b.example',
      lang: 'en',
      subject: 's',
      html: 'h',
      reply_to: null,
      related_entity_type: 'companies',
      related_entity_id: 'company-1',
      status: 'queued',
      attempt_count: 0,
      max_attempts: 5,
      next_attempt_at: new Date().toISOString(),
      resend_message_id: null,
      last_error: null,
      last_attempted_at: null,
      sent_at: null,
      delivered_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(isTrialLifecycleJob(base)).toBe(true);
    // trial_started shares related_entity_type='companies' but a different
    // dedup_key prefix -- must NOT be classified as a trial-lifecycle job.
    expect(isTrialLifecycleJob({ ...base, dedup_key: 'billing:trial_started:company-1:2026-01-01T00:00:00.000000Z:user-1' })).toBe(false);
    expect(isTrialLifecycleJob({ ...base, related_entity_type: 'subscriptions' })).toBe(false);
    expect(isTrialLifecycleJob({ ...base, category: 'invitation' })).toBe(false);
  });
});

describe.skipIf(!SMOKE_DB_URL)('deliverTrialLifecycleJob() — real disposable Postgres', () => {
  afterAll(async () => {
    await testPool.end();
  });

  beforeEach(async () => {
    await testPool.query('TRUNCATE email_jobs, email_events, subscriptions, users, companies CASCADE');
  });

  async function insertCompany(trialEndOffsetMs: number, overrides: { plan?: string; subscriptionStatus?: string } = {}): Promise<string> {
    const { plan = 'trial', subscriptionStatus = 'trial' } = overrides;
    const r = await testPool.query<{ id: string }>(
      `INSERT INTO companies (name, plan, subscription_status, trial_start_date, trial_end_date, timezone)
       VALUES ('Guard Test Co', $1, $2, now() - interval '10 days', clock_timestamp() + ($3 || ' milliseconds')::interval, 'Asia/Kuwait')
       RETURNING id`,
      [plan, subscriptionStatus, String(trialEndOffsetMs)]
    );
    return r.rows[0].id;
  }

  async function currentMarker(companyId: string): Promise<string> {
    const r = await testPool.query<{ marker: string }>(
      `SELECT to_char((trial_end_date AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS marker FROM companies WHERE id = $1`,
      [companyId]
    );
    return r.rows[0].marker;
  }

  async function insertTrialLifecycleJob(params: {
    eventType: 'trial_ending' | 'trial_expired';
    companyId: string;
    marker: string;
    recipientId?: string;
  }): Promise<void> {
    const recipientId = params.recipientId ?? '00000000-0000-0000-0000-000000000001';
    const prefix = params.eventType === 'trial_ending' ? 'billing:trial_ending:' : 'billing:trial_expired:';
    const dedupKey = `${prefix}${params.companyId}:${params.marker}:${recipientId}`;
    await testPool.query(
      `INSERT INTO email_jobs (company_id, category, dedup_key, recipient_email, lang, subject, html, related_entity_type, related_entity_id)
       VALUES ($1, 'billing', $2, 'admin@guardtest.example', 'en', 'subject', '<p>html</p>', 'companies', $1)`,
      [params.companyId, dedupKey]
    );
  }

  // Mirrors claimJobById()'s exact shape (status='processing', attempt_count += 1) —
  // claimJobById/claimBatch aren't exported, so the claim step is reproduced
  // directly against the real schema, same as this design's own SMOKE_*
  // precedent scripts always did for internal, unexported functions.
  async function claim(dedupKeyPrefix: string): Promise<EmailJobRow> {
    const r = await testPool.query<EmailJobRow>(
      `UPDATE email_jobs SET status = 'processing', attempt_count = attempt_count + 1, updated_at = now()
       WHERE dedup_key LIKE $1 || '%' RETURNING *`,
      [dedupKeyPrefix]
    );
    return r.rows[0];
  }

  describe('attempt-budget neutrality (§4.3, item 1/2)', () => {
    it('five consecutive claim -> NOWAIT-deferral cycles leave attempt_count = 0 every time', async () => {
      const companyId = await insertCompany(3600_000);
      const marker = await currentMarker(companyId);
      await insertTrialLifecycleJob({ eventType: 'trial_ending', companyId, marker });

      // A second, independent connection holds the companies row lock
      // (blocking, no NOWAIT) for the whole loop -- every guard attempt below
      // must therefore hit 55P03, never actually reach eligibility/delivery.
      const lockHolder = await testPool.connect();
      await lockHolder.query('BEGIN');
      await lockHolder.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
      try {
        for (let cycle = 0; cycle < 5; cycle++) {
          const job = await claim('billing:trial_ending:');
          expect(job.attempt_count).toBe(1); // freshly incremented by claim()
          const outcome = await deliverTrialLifecycleJob(job);
          expect(outcome).toBe('temp_failed');
          const after = await testPool.query<{ attempt_count: number; status: string }>('SELECT attempt_count, status FROM email_jobs WHERE id = $1', [
            job.id,
          ]);
          expect(after.rows[0].attempt_count).toBe(0); // net-zero: +1 at claim, -1 at deferral
          expect(after.rows[0].status).toBe('temp_failed');
          // Reset to 'queued' so the next cycle's claim() can pick it up again.
          await testPool.query("UPDATE email_jobs SET status = 'queued' WHERE id = $1", [job.id]);
        }
      } finally {
        await lockHolder.query('ROLLBACK');
        lockHolder.release();
      }
    });

    it('a genuine (uncontended) delivery attempt is NEVER budget-neutralized — attempt_count stays at its incremented value', async () => {
      const companyId = await insertCompany(3600_000);
      const marker = await currentMarker(companyId);
      await insertTrialLifecycleJob({ eventType: 'trial_ending', companyId, marker });
      const job = await claim('billing:trial_ending:');
      expect(job.attempt_count).toBe(1);

      // No lock contention this time -- the guard wins the lock immediately,
      // finds the company still eligible, and (dev-mode, no RESEND_API_KEY in
      // this test environment) resolves to 'dev_skipped' -- a real,
      // uncontended attempt, structurally distinct from a 55P03 deferral.
      const outcome = await deliverTrialLifecycleJob(job);
      expect(outcome).toBe('dev_skipped');
      const after = await testPool.query<{ attempt_count: number }>('SELECT attempt_count FROM email_jobs WHERE id = $1', [job.id]);
      expect(after.rows[0].attempt_count).toBe(1); // NOT decremented
    });
  });

  it('NOWAIT contention fails fast (milliseconds), never blocks on a held companies lock (item 9)', async () => {
    const companyId = await insertCompany(3600_000);
    const marker = await currentMarker(companyId);
    await insertTrialLifecycleJob({ eventType: 'trial_ending', companyId, marker });
    const job = await claim('billing:trial_ending:');

    const lockHolder = await testPool.connect();
    await lockHolder.query('BEGIN');
    await lockHolder.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    try {
      const start = Date.now();
      const outcome = await deliverTrialLifecycleJob(job);
      const elapsedMs = Date.now() - start;
      expect(outcome).toBe('temp_failed');
      // Generous upper bound for a CI/sandbox environment -- the point being
      // proven is "near-instant", not blocked for seconds.
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      await lockHolder.query('ROLLBACK');
      lockHolder.release();
    }
  });

  describe('Order A / Order B — activation vs. delivery (§4.7, items 10/11)', () => {
    it('Order A (activation commits FIRST): the guard finds the company no longer eligible and cancels without ever calling Resend', async () => {
      const companyId = await insertCompany(3600_000);
      const marker = await currentMarker(companyId);
      await insertTrialLifecycleJob({ eventType: 'trial_ending', companyId, marker });
      const job = await claim('billing:trial_ending:');

      // Simulate activateSubscription()'s committed effect -- already
      // committed BEFORE the guard ever runs, exactly what "activation
      // acquires the lock first, then commits" collapses to once serialized.
      await testPool.query(`UPDATE companies SET plan = 'gold', subscription_status = 'active' WHERE id = $1`, [companyId]);

      const fetchSpy = vi.spyOn(global, 'fetch');
      const outcome = await deliverTrialLifecycleJob(job);
      expect(outcome).toBe('cancelled');
      expect(fetchSpy).not.toHaveBeenCalled(); // zero Resend calls, exactly as §4.7 Order A requires
      fetchSpy.mockRestore();

      const row = await testPool.query<{ status: string }>('SELECT status FROM email_jobs WHERE id = $1', [job.id]);
      expect(row.rows[0].status).toBe('cancelled');
    });

    it('Order A, extension variant: a changed trial_end_date (different marker) is also caught and cancelled, not just plan/status changes', async () => {
      const companyId = await insertCompany(3600_000);
      const marker = await currentMarker(companyId);
      await insertTrialLifecycleJob({ eventType: 'trial_ending', companyId, marker });
      const job = await claim('billing:trial_ending:');

      // Simulate updateCompany() extending the trial -- still 'trial'/'trial',
      // so only the MARKER comparison (not the eligibility flags) can catch
      // this, exactly as §4.7's extension-variant paragraph states.
      await testPool.query(`UPDATE companies SET trial_end_date = trial_end_date + interval '10 days' WHERE id = $1`, [companyId]);

      const outcome = await deliverTrialLifecycleJob(job);
      expect(outcome).toBe('cancelled');
    });

    it('Order B (the guard acquires the lock first, uncontended): delivery proceeds using the still-valid pre-commit state', async () => {
      const companyId = await insertCompany(3600_000);
      const marker = await currentMarker(companyId);
      await insertTrialLifecycleJob({ eventType: 'trial_ending', companyId, marker });
      const job = await claim('billing:trial_ending:');

      // No concurrent activation at all this time -- the guard is free to
      // acquire the lock and, finding the company genuinely still eligible,
      // legitimately proceeds through delivery (dev-mode terminal state).
      const outcome = await deliverTrialLifecycleJob(job);
      expect(outcome).toBe('dev_skipped');
    });

    it('Order B, the underlying Postgres guarantee: a concurrent blocking FOR UPDATE on companies cannot proceed until the lock-holder commits', async () => {
      // This is the raw-SQL proof of the invariant deliverTrialLifecycleJob()
      // depends on for Order B (§4.7) -- the guard's own dev-mode delivery
      // resolves in milliseconds, too fast to reliably race a second
      // connection without an artificial delay hook into application code,
      // so the underlying Postgres locking guarantee is proven directly here
      // (same two-connection method this design's earlier rounds used),
      // exactly as it would apply for as long as the guard's real transaction
      // holds the lock through an actual ~15s Resend call in production.
      const companyId = await insertCompany(3600_000);
      const holder = await testPool.connect();
      const blocked = await testPool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);

        await blocked.query('BEGIN');
        const blockedStart = Date.now();
        const blockedPromise = blocked.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);

        await new Promise((resolve) => setTimeout(resolve, 300));
        // Still blocked 300ms in -- not resolved yet.
        let settled = false;
        blockedPromise.then(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled).toBe(false);

        await holder.query('COMMIT');
        await blockedPromise;
        const blockedElapsedMs = Date.now() - blockedStart;
        expect(blockedElapsedMs).toBeGreaterThanOrEqual(300); // proves it genuinely waited for the commit
        await blocked.query('COMMIT');
      } finally {
        holder.release();
        blocked.release();
      }
    });
  });

  describe('event-specific temporal staleness (§4.2)', () => {
    it('a trial_ending job whose trial has since elapsed (marker unchanged, time simply passed) is cancelled at delivery time', async () => {
      // trial_end_date already 200ms in the PAST relative to insertion, but
      // the marker embedded in the dedup_key was computed at that same
      // instant -- the marker will still match exactly (trial_end_date never
      // mutated), so ONLY the temporal (guard_now-vs-trial_end) check can
      // catch this, exactly as §4.1/§4.2 describe.
      const companyId = await insertCompany(-200);
      const marker = await currentMarker(companyId);
      await insertTrialLifecycleJob({ eventType: 'trial_ending', companyId, marker });
      const job = await claim('billing:trial_ending:');

      // Confirm the marker really is still identical (proving this is a
      // genuine temporal-staleness case, not a marker-mismatch one).
      const stillMatches = await currentMarker(companyId);
      expect(stillMatches).toBe(marker);

      const outcome = await deliverTrialLifecycleJob(job);
      expect(outcome).toBe('cancelled');
    });

    it('a trial_expired job whose trial has NOT actually elapsed yet (theoretical defense-in-depth case) is cancelled too', async () => {
      const companyId = await insertCompany(3600_000); // still 1h in the future
      const marker = await currentMarker(companyId);
      // A trial_expired job is only ever inserted by the candidate query once
      // trial_end_date <= sweepNow -- crafting one here with a still-future
      // trial_end_date exercises the guard's own independent defense-in-depth
      // check directly, matching this design's principle of never trusting
      // insertion-time correctness at delivery time (§4.1).
      await insertTrialLifecycleJob({ eventType: 'trial_expired', companyId, marker });
      const job = await claim('billing:trial_expired:');
      const outcome = await deliverTrialLifecycleJob(job);
      expect(outcome).toBe('cancelled');
    });
  });

  describe('Layer A — starts_with() exact-prefix cancellation (§4.6, item 16)', () => {
    it('cancels trial_ending/trial_expired but leaves trial_started (same related_entity_type) untouched', async () => {
      const companyId = await insertCompany(3600_000);
      const marker = await currentMarker(companyId);
      await testPool.query(
        `INSERT INTO email_jobs (company_id, category, dedup_key, recipient_email, lang, subject, html, related_entity_type, related_entity_id, status)
         VALUES
           ($1, 'billing', $2, 'a@x.example', 'en', 's', 'h', 'companies', $1, 'queued'),
           ($1, 'billing', $3, 'a@x.example', 'en', 's', 'h', 'companies', $1, 'queued'),
           ($1, 'billing', $4, 'a@x.example', 'en', 's', 'h', 'companies', $1, 'temp_failed')`,
        [
          companyId,
          `billing:trial_started:${companyId}:2026-01-01T00:00:00.000000Z:user-1`,
          `billing:trial_ending:${companyId}:${marker}:user-1`,
          `billing:trial_expired:${companyId}:${marker}:user-2`,
        ]
      );

      // The exact Layer A statement from admin.controller.ts::activateSubscription().
      await testPool.query(
        `UPDATE email_jobs
         SET status = 'cancelled', updated_at = now()
         WHERE company_id = $1 AND category = 'billing' AND related_entity_type = 'companies' AND related_entity_id = $1
           AND status IN ('queued', 'temp_failed')
           AND (starts_with(dedup_key, 'billing:trial_ending:') OR starts_with(dedup_key, 'billing:trial_expired:'))`,
        [companyId]
      );

      const rows = await testPool.query<{ dedup_key: string; status: string }>(
        'SELECT dedup_key, status FROM email_jobs WHERE company_id = $1 ORDER BY dedup_key',
        [companyId]
      );
      const byPrefix = (p: string) => rows.rows.find((r) => r.dedup_key.startsWith(p))!;
      expect(byPrefix('billing:trial_started:').status).toBe('queued'); // untouched
      expect(byPrefix('billing:trial_ending:').status).toBe('cancelled');
      expect(byPrefix('billing:trial_expired:').status).toBe('cancelled');
    });
  });
});
