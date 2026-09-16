import { pool } from '../db/pool';
import { env } from '../config/env';
import { resolveBillingRecipients } from './billingRecipients';
import {
  insertEmailJob,
  trialEndingEmailHtml,
  trialExpiredEmailHtml,
  TRIAL_ENDING_DEDUP_PREFIX,
  TRIAL_EXPIRED_DEDUP_PREFIX,
} from './email';

// ============================================================================
// Chat 4C, Stage B4B — Trial ending & expired lifecycle emails.
// See claude/chat4c-b4b-trial-lifecycle-emails-proposal-2026-09-16.md (project
// doc, Design Pass v8) for the full reviewed design this file implements.
//
// This file ONLY ever durably inserts jobs (via insertEmailJob(), never
// enqueueEmail()) — it never triggers delivery itself. Delivery happens
// exclusively via the existing sweepEmailQueue() (utils/email.ts), which
// dispatches a trial-lifecycle job to deliverTrialLifecycleJob() (also in
// utils/email.ts — the delivery-time guard, design v8 §4) instead of the
// ordinary deliverViaResend() path. Nothing in this file ever calls Resend,
// and nothing in this file ever imports or calls attemptDeliverNow().
// ============================================================================

// Hardcoded to this feature's actual implementation date (design v8 §8).
// Lifecycles resolving to before this instant are permanently excluded from
// both candidate queries below. Never recomputed at runtime.
export const TRIAL_LIFECYCLE_LAUNCH_CUTOFF_UTC = '2026-09-16T00:00:00.000000Z';

type TrialLifecycleEventType = 'trial_ending' | 'trial_expired';

const DEDUP_PREFIX: Record<TrialLifecycleEventType, string> = {
  trial_ending: TRIAL_ENDING_DEDUP_PREFIX,
  trial_expired: TRIAL_EXPIRED_DEDUP_PREFIX,
};

interface TrialLifecycleCandidate {
  companyId: string;
  marker: string;
}

// Design v8 §6 — company-grouped, SQL-computed-marker-only candidate query.
// `trial_ending`'s boundary is `(sweepNow, sweepNow + 2 days]`; `trial_expired`'s
// is `(-inf, sweepNow]` — the only difference between the two event types'
// SQL. The final SELECT returns ONLY `company_id` and the SQL-computed
// `marker` string — never a raw trial_end_date (review point 2 / v8 change 2).
// `ORDER BY trial_end_date` is valid even though only `marker` is in the
// outer SELECT list because `trial_end_date` is a GROUP BY key — verified
// against a real Postgres instance (trialLifecycleEmails.smoke.test.ts).
async function queryCandidates(eventType: TrialLifecycleEventType, sweepNow: Date, limit: number): Promise<TrialLifecycleCandidate[]> {
  const boundaryClause =
    eventType === 'trial_ending'
      ? `(c.trial_end_date AT TIME ZONE 'UTC') > $1::timestamptz AND (c.trial_end_date AT TIME ZONE 'UTC') <= $1::timestamptz + interval '2 days'`
      : `(c.trial_end_date AT TIME ZONE 'UTC') <= $1::timestamptz`;
  const dedupPrefix = DEDUP_PREFIX[eventType];

  const result = await pool.query<{ company_id: string; marker: string }>(
    `WITH trial_candidates AS (
       SELECT c.id, c.trial_end_date
       FROM companies c
       WHERE c.plan = 'trial' AND c.subscription_status = 'trial' AND c.trial_end_date IS NOT NULL
         AND ${boundaryClause}
         AND (c.trial_end_date AT TIME ZONE 'UTC') >= $3::timestamptz
         AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.company_id = c.id AND s.status IN ('active', 'past_due'))
     ),
     eligible_admins AS (
       SELECT u.id, tc.id AS company_id, tc.trial_end_date,
              ROW_NUMBER() OVER (PARTITION BY u.company_id, lower(trim(u.email)) ORDER BY u.created_at ASC, u.id ASC) AS rn
       FROM users u JOIN trial_candidates tc ON tc.id = u.company_id
       WHERE u.role = 'admin' AND u.status = 'active' AND trim(u.email) ~ '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$'
     ),
     pending_recipients AS (
       SELECT ea.company_id, ea.trial_end_date
       FROM eligible_admins ea
       WHERE ea.rn = 1
         AND NOT EXISTS (
           SELECT 1 FROM email_jobs ej
           WHERE ej.dedup_key = '${dedupPrefix}' || ea.company_id::text || ':'
                                 || to_char((ea.trial_end_date AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                                 || ':' || ea.id::text
         )
     )
     SELECT company_id,
            to_char((trial_end_date AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS marker
     FROM pending_recipients
     GROUP BY company_id, trial_end_date
     ORDER BY trial_end_date ASC
     LIMIT $2`,
    [sweepNow, limit, TRIAL_LIFECYCLE_LAUNCH_CUTOFF_UTC]
  );
  return result.rows.map((row) => ({ companyId: row.company_id, marker: row.marker }));
}

// Design v8 §2.2 — the per-company transaction. Locks `companies FOR UPDATE`
// (same lock, same order as activateSubscription()/updateCompany() — §3),
// rechecks eligibility and the candidate's own marker ENTIRELY IN SQL (never
// a raw trial_end_date crossing into JS — review point 2 / v8 change 2), then
// — if still eligible — resolves the current recipient set on the SAME
// client (never the plain pool, so it sees this transaction's own lock) and
// durably inserts one job per real recipient via insertEmailJob(), NEVER
// enqueueEmail() (§2.2, §11 item 3 — no attemptDeliverNow() fan-out). Returns
// the number of jobs actually inserted for this company (0 if the recheck
// failed, or if the company currently has no real recipients).
async function processCandidate(eventType: TrialLifecycleEventType, companyId: string, candidateMarker: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const recheck = await client.query<{
      name: string;
      still_trial_eligible: boolean;
      marker: string;
      marker_at_or_after_cutoff: boolean;
    }>(
      `SELECT c.name,
              (c.plan = 'trial' AND c.subscription_status = 'trial') AS still_trial_eligible,
              to_char((c.trial_end_date AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS marker,
              ((c.trial_end_date AT TIME ZONE 'UTC') >= $2::timestamptz) AS marker_at_or_after_cutoff
       FROM companies c WHERE c.id = $1 FOR UPDATE`,
      [companyId, TRIAL_LIFECYCLE_LAUNCH_CUTOFF_UTC]
    );
    const company = recheck.rows[0];
    // Abort with no writes unless still eligible, past the launch cutoff, and
    // the marker matches the candidate that made this company a candidate in
    // the first place (a plain string-equality comparison, never a Date
    // comparison) — catches a company whose trial_end_date changed (or whose
    // plan/subscription_status changed) between the outer candidate query and
    // this lock being acquired.
    if (!company || !company.still_trial_eligible || !company.marker_at_or_after_cutoff || company.marker !== candidateMarker) {
      await client.query('ROLLBACK');
      return 0;
    }

    const liveSub = await client.query<{ has_live_subscription: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM subscriptions WHERE company_id = $1 AND status IN ('active', 'past_due')) AS has_live_subscription`,
      [companyId]
    );
    if (liveSub.rows[0]?.has_live_subscription) {
      await client.query('ROLLBACK');
      return 0;
    }

    // SAME client, never pool — sees this transaction's own lock, and its own
    // uncommitted view is irrelevant here since resolveBillingRecipients()
    // only ever reads `users`/`companies`, neither of which this transaction
    // has written to.
    const recipients = await resolveBillingRecipients(companyId, client);
    if (recipients.length === 0) {
      await client.query('COMMIT');
      return 0;
    }

    const dedupPrefix = DEDUP_PREFIX[eventType];
    const billingLink = `${env.FRONTEND_URL}/account?section=billing`;
    const buildTemplate = eventType === 'trial_ending' ? trialEndingEmailHtml : trialExpiredEmailHtml;

    let inserted = 0;
    for (const recipient of recipients) {
      const { subject, html } = buildTemplate({
        lang: recipient.preferredLanguage,
        timeZone: recipient.companyTimezone,
        companyName: company.name,
        // `marker` is the SQL-normalized UTC ISO value for the legacy
        // TIMESTAMP WITHOUT TIME ZONE column. Passing that string avoids
        // node-postgres interpreting the raw column in the process timezone.
        trialEndDate: company.marker,
        link: billingLink,
      });
      const result = await insertEmailJob(client, {
        to: recipient.email,
        subject,
        html,
        category: 'billing',
        lang: recipient.preferredLanguage,
        // Design v8 §7's exact dedup-key format: event prefix + company ID +
        // SQL-computed marker (the SAME marker just re-verified above, not a
        // freshly recomputed one) + recipient user ID.
        dedupKey: `${dedupPrefix}${companyId}:${company.marker}:${recipient.userId}`,
        companyId,
        relatedEntityType: 'companies',
        relatedEntityId: companyId,
      });
      if (result.inserted) inserted++;
    }

    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Design v8 §2.1 — the self-guard, checked FIRST, before any DB access, same
// convention as sweepEmailQueue() (utils/email.ts, SLA timezone incident
// 2026-09-09). Captures ONE `clock_timestamp()` instant per sweep tick,
// reused for both event types' candidate queries and every per-company
// recheck in that tick (§11 item 21). The captured value is a PostgreSQL
// TIMESTAMPTZ (safe to parse as an absolute JS Date), never the legacy
// TIMESTAMP WITHOUT TIME ZONE trial column and never JS-derived wall time.
export async function sweepTrialLifecycleEmails(limit = 50): Promise<{ candidatesFound: number; jobsInserted: number }> {
  if (!env.ENABLE_BACKGROUND_SWEEPS) {
    return { candidatesFound: 0, jobsInserted: 0 };
  }

  const sweepNowResult = await pool.query<{ sweep_now: Date }>('SELECT clock_timestamp() AS sweep_now');
  const sweepNow = sweepNowResult.rows[0].sweep_now;

  let candidatesFound = 0;
  let jobsInserted = 0;

  for (const eventType of ['trial_ending', 'trial_expired'] as const) {
    let candidates: TrialLifecycleCandidate[] = [];
    try {
      candidates = await queryCandidates(eventType, sweepNow, limit);
    } catch (err) {
      console.error(`[trialLifecycleEmails] sweepTrialLifecycleEmails: candidate query failed for ${eventType}`, err);
      continue;
    }
    candidatesFound += candidates.length;
    for (const candidate of candidates) {
      try {
        jobsInserted += await processCandidate(eventType, candidate.companyId, candidate.marker);
      } catch (err) {
        console.error(`[trialLifecycleEmails] sweepTrialLifecycleEmails: processCandidate failed for company ${candidate.companyId}`, err);
      }
    }
  }

  return { candidatesFound, jobsInserted };
}
