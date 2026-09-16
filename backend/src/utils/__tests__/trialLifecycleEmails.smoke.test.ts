import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// trialLifecycleEmails.smoke.test.ts — Chat 4C, Stage B4B (design v8 §10/§11).
// Disposable-Postgres smoke test, this design's SMOKE_B2/SMOKE_B3-pattern
// equivalent — candidate-query correctness (§6), company-grouping at
// 0/partial/full dedup states, boundary fixtures, launch cutoff, candidate
// idempotency, and the ENABLE_BACKGROUND_SWEEPS self-guard (§2.1).
//
// The real-DB tests below run ONLY when B4B_SMOKE_DATABASE_URL points at a
// disposable Postgres instance carrying the real companies/users/
// subscriptions/email_jobs schema (see this repo's own docs/MIGRATION_076_*,
// docs/MIGRATION_082_*, docs/MIGRATION_043_hrms_performance_sla.sql for
// companies.timezone). Unset (the default — including a plain `npx vitest
// run`), the whole suite below is skipped, exactly like this codebase's
// existing SMOKE_*.js scripts (docs/) are never part of `npm test` either —
// this file simply keeps its DB-backed assertions IN vitest, guarded, rather
// than as a wholly separate script.
// ============================================================================

const SMOKE_DB_URL = process.env.B4B_SMOKE_DATABASE_URL;

const { testPool } = vi.hoisted(() => {
  // config/env.ts reads `process.env.ENABLE_BACKGROUND_SWEEPS === 'true'`
  // ONCE, at module-import time, into the frozen `env.ENABLE_BACKGROUND_SWEEPS`
  // boolean this file's own module chain (../trialLifecycleEmails -> ../../config/env)
  // captures on import below. Setting it later, e.g. in beforeAll, would be too
  // late -- static `import` statements are hoisted and run before any test
  // hook. It must be set here, inside vi.hoisted(), which vitest guarantees
  // runs before any import in this file is evaluated. (Only meaningful when
  // SMOKE_DB_URL is set -- an unset B4B_SMOKE_DATABASE_URL still leaves the
  // guard permanently on in this process, but the describe.skipIf below then
  // skips every test that would exercise it, so no import.meta env pollution
  // reaches a plain `npx vitest run` and every other test file gets a fresh
  // module registry per file.)
  if (process.env.B4B_SMOKE_DATABASE_URL) {
    process.env.ENABLE_BACKGROUND_SWEEPS = 'true';
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PoolCtor } = require('pg');
  return {
    testPool: new PoolCtor({ connectionString: process.env.B4B_SMOKE_DATABASE_URL || 'postgres://unused:unused@127.0.0.1:1/unused' }) as Pool,
  };
});
vi.mock('../../db/pool', () => ({ pool: testPool }));

import { sweepTrialLifecycleEmails, TRIAL_LIFECYCLE_LAUNCH_CUTOFF_UTC } from '../trialLifecycleEmails';

// ---------------------------------------------------------------------------
// The ENABLE_BACKGROUND_SWEEPS self-guard (§2.1, §11 items 6/7) — a
// source-text check, NOT a live call, same convention email.ts's own
// "SLA timezone incident — ENABLE_BACKGROUND_SWEEPS guard" test already uses
// for sweepEmailQueue() (see src/utils/__tests__/email.test.ts). This runs
// unconditionally (no DB, no env var needed) — it is what guarantees a local
// process without B4B_SMOKE_DATABASE_URL (or a production instance with the
// flag off) never issues a single query from this sweep.
// ---------------------------------------------------------------------------
describe('sweepTrialLifecycleEmails() — ENABLE_BACKGROUND_SWEEPS self-guard (source check)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../trialLifecycleEmails.ts'), 'utf-8');

  it('checks env.ENABLE_BACKGROUND_SWEEPS and returns BEFORE any database access', () => {
    const guardIdx = source.indexOf('if (!env.ENABLE_BACKGROUND_SWEEPS)');
    const firstQueryIdx = source.indexOf("pool.query<{ sweep_now: Date }>('SELECT clock_timestamp()");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(firstQueryIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(firstQueryIdx);
  });

  it('the guard is the first statement in the function body (before ANY other code)', () => {
    const fnStart = source.indexOf('export async function sweepTrialLifecycleEmails');
    const guardIdx = source.indexOf('if (!env.ENABLE_BACKGROUND_SWEEPS)');
    const bodyBetween = source.slice(fnStart, guardIdx);
    // Only the function signature/opening brace and comments may appear
    // between the function start and the guard — no query, no loop, no
    // candidate/processCandidate call.
    expect(bodyBetween).not.toMatch(/pool\.(query|connect)/);
    expect(bodyBetween).not.toContain('queryCandidates');
    expect(bodyBetween).not.toContain('processCandidate');
  });

  it("the guard's early return matches its own resolved shape exactly ({ candidatesFound: 0, jobsInserted: 0 })", () => {
    const guardBlock = source.slice(source.indexOf('if (!env.ENABLE_BACKGROUND_SWEEPS)'), source.indexOf('const sweepNowResult'));
    expect(guardBlock).toContain('{ candidatesFound: 0, jobsInserted: 0 }');
  });
});

describe.skipIf(!!SMOKE_DB_URL)('sweepTrialLifecycleEmails() — disabled runtime guard', () => {
  it('returns without touching PostgreSQL when background sweeps are disabled', async () => {
    const querySpy = vi.spyOn(testPool, 'query');

    await expect(sweepTrialLifecycleEmails()).resolves.toEqual({ candidatesFound: 0, jobsInserted: 0 });
    expect(querySpy).not.toHaveBeenCalled();

    querySpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Real-DB tests — skipped unless B4B_SMOKE_DATABASE_URL is set.
// ---------------------------------------------------------------------------
describe.skipIf(!SMOKE_DB_URL)('sweepTrialLifecycleEmails() — real disposable Postgres', () => {
  afterAll(async () => {
    await testPool.end();
  });

  beforeEach(async () => {
    await testPool.query('TRUNCATE email_jobs, email_events, subscriptions, users, companies CASCADE');
  });

  // trial_end_date is computed SQL-side, relative to the database's own
  // clock_timestamp() at INSERT time -- never a JS Date snapshotted earlier
  // in the test file (a `beforeAll`-captured "now" drifts further from the
  // real clock with every test that runs before it, which is exactly what
  // made the tight boundary fixtures below flaky). Mirrors
  // trialLifecycleGuard.smoke.test.ts's own insertCompany() helper.
  async function insertCompany(overrides: {
    trialEndDeltaMs: number;
    plan?: string;
    subscriptionStatus?: string;
    name?: string;
  }): Promise<string> {
    const { trialEndDeltaMs, plan = 'trial', subscriptionStatus = 'trial', name = 'Test Co' } = overrides;
    const r = await testPool.query<{ id: string }>(
      `INSERT INTO companies (name, plan, subscription_status, trial_start_date, trial_end_date, timezone)
       VALUES ($1, $2, $3, clock_timestamp() - interval '1 second', clock_timestamp() + ($4 || ' milliseconds')::interval, 'Asia/Kuwait')
       RETURNING id`,
      [name, plan, subscriptionStatus, String(trialEndDeltaMs)]
    );
    return r.rows[0].id;
  }

  async function insertAdmin(companyId: string, email: string, overrides: { status?: string; role?: string } = {}): Promise<string> {
    const { status = 'active', role = 'admin' } = overrides;
    const r = await testPool.query<{ id: string }>(
      `INSERT INTO users (company_id, email, role, status, preferred_language) VALUES ($1, $2, $3, $4, 'en') RETURNING id`,
      [companyId, email, role, status]
    );
    return r.rows[0].id;
  }

  // §11's boundary fixtures. The design doc frames these as "+1us"/"-1us"
  // of the boundary; in practice, this test inserts via one round trip and
  // sweeps via a second, separate round trip that captures its own fresh
  // clock_timestamp() (by design — see §2.1/§11 item 21, never reused across
  // calls), so a literal 1-microsecond margin is indistinguishable from
  // measurement jitter between those two round trips and was flaky. A 250ms
  // margin preserves the same boundary-crossing intent (just inside vs. just
  // outside the window, never the exact boundary value itself — that's
  // covered by the $instant/$instant+2d fixtures below) while being an order
  // of magnitude larger than this environment's actual round-trip jitter.
  describe('boundary fixtures', () => {
    it('$instant + 2d + 250ms -> neither ending nor expired', async () => {
      const companyId = await insertCompany({ trialEndDeltaMs: 2 * 86400_000 + 250 });
      await insertAdmin(companyId, 'admin@boundary1.example');
      const result = await sweepTrialLifecycleEmails(100);
      const jobs = await testPool.query('SELECT dedup_key FROM email_jobs WHERE company_id = $1', [companyId]);
      expect(jobs.rows).toHaveLength(0);
      expect(result.jobsInserted).toBe(0);
    });

    it('$instant + 2d -> ending (inclusive upper boundary)', async () => {
      const companyId = await insertCompany({ trialEndDeltaMs: 2 * 86400_000 });
      await insertAdmin(companyId, 'admin@boundary2.example');
      await sweepTrialLifecycleEmails(100);
      const jobs = await testPool.query<{ dedup_key: string }>('SELECT dedup_key FROM email_jobs WHERE company_id = $1', [companyId]);
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0].dedup_key).toContain('billing:trial_ending:');
    });

    it('$instant + 250ms -> ending', async () => {
      const companyId = await insertCompany({ trialEndDeltaMs: 250 });
      await insertAdmin(companyId, 'admin@boundary3.example');
      await sweepTrialLifecycleEmails(100);
      const jobs = await testPool.query<{ dedup_key: string }>('SELECT dedup_key FROM email_jobs WHERE company_id = $1', [companyId]);
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0].dedup_key).toContain('billing:trial_ending:');
    });

    it('$instant -> expired, never ending (exclusive lower boundary of "ending")', async () => {
      const companyId = await insertCompany({ trialEndDeltaMs: 0 });
      await insertAdmin(companyId, 'admin@boundary4.example');
      await sweepTrialLifecycleEmails(100);
      const jobs = await testPool.query<{ dedup_key: string }>('SELECT dedup_key FROM email_jobs WHERE company_id = $1', [companyId]);
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0].dedup_key).toContain('billing:trial_expired:');
    });

    it('$instant - 250ms -> expired', async () => {
      const companyId = await insertCompany({ trialEndDeltaMs: -250 });
      await insertAdmin(companyId, 'admin@boundary5.example');
      await sweepTrialLifecycleEmails(100);
      const jobs = await testPool.query<{ dedup_key: string }>('SELECT dedup_key FROM email_jobs WHERE company_id = $1', [companyId]);
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0].dedup_key).toContain('billing:trial_expired:');
    });
  });

  describe('company-level grouping and per-recipient dedup (§6, item 17)', () => {
    it('a 5-admin company produces exactly one candidate/one job row per admin (never LIMIT-starved by a single company)', async () => {
      const companyId = await insertCompany({ trialEndDeltaMs: 3600_000 });
      for (let i = 0; i < 5; i++) await insertAdmin(companyId, `admin${i}@fiveadmins.example`);
      const result = await sweepTrialLifecycleEmails(100);
      expect(result.candidatesFound).toBe(1); // one candidate ROW at the company level
      expect(result.jobsInserted).toBe(5); // but one job per real recipient
      const jobs = await testPool.query('SELECT recipient_email FROM email_jobs WHERE company_id = $1', [companyId]);
      expect(jobs.rows).toHaveLength(5);
    });

    it('partial delivery (2 of 5 already have a job) inserts only the remaining 3 on the next sweep', async () => {
      const companyId = await insertCompany({ trialEndDeltaMs: 3600_000 });
      const adminIds: string[] = [];
      for (let i = 0; i < 5; i++) adminIds.push(await insertAdmin(companyId, `admin${i}@partial.example`));
      const first = await sweepTrialLifecycleEmails(100);
      expect(first.jobsInserted).toBe(5);
      // Re-running immediately must be a true no-op — full idempotency (item 18).
      const second = await sweepTrialLifecycleEmails(100);
      expect(second.candidatesFound).toBe(0);
      expect(second.jobsInserted).toBe(0);
    });

    it('once ALL real recipients already have a job for the current marker, the company is no longer a candidate at all', async () => {
      const companyId = await insertCompany({ trialEndDeltaMs: 3600_000 });
      await insertAdmin(companyId, 'admin@cleared.example');
      await sweepTrialLifecycleEmails(100);
      const result = await sweepTrialLifecycleEmails(100);
      expect(result.candidatesFound).toBe(0);
    });
  });

  describe('starvation-safety and exclusions', () => {
    it('an inactive admin and a non-admin employee are never recipients', async () => {
      const companyId = await insertCompany({ trialEndDeltaMs: 3600_000 });
      await insertAdmin(companyId, 'inactive@excluded.example', { status: 'inactive' });
      await insertAdmin(companyId, 'employee@excluded.example', { role: 'employee' });
      const result = await sweepTrialLifecycleEmails(100);
      expect(result.candidatesFound).toBe(0); // no eligible admin -> never a candidate at all
      expect(result.jobsInserted).toBe(0);
    });

    it('normalized-email duplicates collapse to one recipient', async () => {
      const companyId = await insertCompany({ trialEndDeltaMs: 3600_000 });
      await insertAdmin(companyId, 'Admin@Dup.example');
      await insertAdmin(companyId, '  admin@dup.example  ');
      const result = await sweepTrialLifecycleEmails(100);
      expect(result.jobsInserted).toBe(1);
    });

    it('a company on an active/past_due subscription is never a candidate, even if trial_end_date is in the window', async () => {
      const companyId = await insertCompany({ trialEndDeltaMs: 3600_000 });
      await insertAdmin(companyId, 'admin@livesub.example');
      await testPool.query(
        `INSERT INTO subscriptions (company_id, plan, status, currency, billing_interval, current_period_start, current_period_end, period_amount)
         VALUES ($1, 'gold', 'active', 'USD', 'monthly', now(), now() + interval '30 days', 55)`,
        [companyId]
      );
      const result = await sweepTrialLifecycleEmails(100);
      expect(result.candidatesFound).toBe(0);
    });
  });

  describe('launch cutoff (§8, item 19)', () => {
    it('excludes a trial_end_date resolving to before TRIAL_LIFECYCLE_LAUNCH_CUTOFF_UTC', async () => {
      const cutoff = new Date(TRIAL_LIFECYCLE_LAUNCH_CUTOFF_UTC);
      // A company whose trial ended (or is ending) entirely before the
      // feature's own launch cutoff — inserted directly with an absolute
      // pre-cutoff trial_end_date, independent of the database's current time.
      const r = await testPool.query<{ id: string }>(
        `INSERT INTO companies (name, plan, subscription_status, trial_start_date, trial_end_date, timezone)
         VALUES ('Pre-launch Co', 'trial', 'trial', $1, $1, 'Asia/Kuwait') RETURNING id`,
        [new Date(cutoff.getTime() - 3600_000).toISOString()]
      );
      await insertAdmin(r.rows[0].id, 'admin@precutoff.example');
      const result = await sweepTrialLifecycleEmails(100);
      expect(result.candidatesFound).toBe(0);
    });
  });

  it('item 22: ORDER BY trial_end_date remains valid though only `marker` is in the outer SELECT (GROUP BY key)', async () => {
    // If this were invalid SQL, sweepTrialLifecycleEmails() itself would
    // throw (the candidate query is what uses this ORDER BY) — so a company
    // successfully receiving its job IS the proof.
    const companyId = await insertCompany({ trialEndDeltaMs: 3600_000 });
    await insertAdmin(companyId, 'admin@orderby.example');
    await expect(sweepTrialLifecycleEmails(100)).resolves.toEqual({ candidatesFound: 1, jobsInserted: 1 });
  });
});
