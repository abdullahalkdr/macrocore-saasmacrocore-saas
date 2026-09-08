-- MIGRATION_076_email_foundation.sql
-- Macrocore Email System, Chat 1 — shared transactional-email foundation.
--
-- REVISED 2026-09-08 (before ever being run — Abdullah caught the first draft's
-- gap during review: a fire-and-forget send + a simple attempt-log is not durable
-- delivery). This is the ONLY version of MIGRATION_076 — no MIGRATION_077 exists
-- to patch it, since the original was never applied to any database.
--
-- REVISED AGAIN 2026-09-08 (reliability pass, still before ever being run):
-- added the 'requires_review' status (a job reclaimed after an apparent
-- backend crash mid-delivery, past the point it can be safely auto-retried —
-- see utils/email.ts's reclaimStuckProcessingJobs()) and email_events.applied_at
-- (marks a webhook event as successfully correlated to a job and processed —
-- NULL means the webhook arrived before the matching job row got its
-- resend_message_id written, and utils/email.ts's reconcilePendingEmailEvents()
-- retries the correlation on every sweep tick until it resolves).
--
-- REVISED A THIRD TIME 2026-09-08 (narrow correction pass on the reliability
-- pass above, still before ever being run): email_events gained
-- reconcile_attempts and next_reconcile_at so reconcilePendingEmailEvents()
-- can back off an event that keeps failing to correlate (same
-- computeBackoffMs() curve email_jobs retries already use) instead of that
-- event permanently occupying the front of every reconcile batch and
-- starving newer, genuinely-correlatable events -- see
-- utils/email.ts's decideReconcileOutcome().
--
-- REVISED A FOURTH TIME 2026-09-08 (after the first real run attempt against
-- the live database failed with "column applied_at does not exist" at the
-- idx_email_events_unapplied index below): email_jobs and/or email_events
-- already existed on the target database in an OLDER shape -- from an
-- earlier run of an earlier version of this same file, before the columns/
-- constraint values added by the revisions above existed. Since CREATE TABLE
-- IF NOT EXISTS is a silent no-op on a table that already exists, none of
-- those additions ever reached that pre-existing table. Added explicit,
-- idempotent ALTER TABLE ... ADD COLUMN IF NOT EXISTS (email_events) and a
-- DROP+ADD CONSTRAINT retrofit (email_jobs' status CHECK) right after each
-- CREATE TABLE, so this file now converges to the same correct final schema
-- whether the tables are being created fresh or already existed in any
-- earlier shape. node scripts/run-sql.js sends this whole file as one
-- multi-statement query, which Postgres runs as a single implicit
-- transaction -- the failed attempt therefore made NO changes at all to the
-- database (nothing partially applied, safe to simply re-run this file).
--
-- Adds:
--   1. email_jobs — a durable queue + delivery-lifecycle table. A row is created
--      the instant a business action decides an email is needed (after that
--      action's own transaction has committed), and is picked up by
--      utils/email.ts's claim-based worker/sweep, not by an in-memory timer that
--      forgets everything on restart. dedup_key is UNIQUE — the same business
--      event enqueued twice (a retried request, a scheduler running twice) is a
--      no-op the second time (ON CONFLICT DO NOTHING), never a duplicate row.
--   2. email_events — raw Resend/Svix webhook event log. svix_id is UNIQUE, so a
--      webhook delivered more than once (Resend/Svix's own documented retry
--      behavior) is idempotent — the second delivery is recognized and ignored
--      before any email_jobs row is touched a second time.
--   3. users.preferred_language — persisted per-user email language (ar/en),
--      independent of the existing UI-only language toggle
--      (frontend/src/store/langStore.ts, localStorage-only) — emails are sent
--      outside any browser session, so the server needs its own known value.
--
-- All additive: no existing column or table is altered or dropped. Safe to run
-- against the live database with zero downtime.
--
-- Run: node scripts/run-sql.js docs/MIGRATION_076_email_foundation.sql

CREATE TABLE IF NOT EXISTS email_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID REFERENCES companies(id) ON DELETE CASCADE,
  category            VARCHAR(50) NOT NULL,
  -- Caller-supplied, stable per business event (e.g.
  -- "verification:register:user:<uuid>") — the single mechanism every kind of
  -- duplicate (retried API call, double scheduler tick, concurrent backend
  -- instance) is prevented through. See utils/email.ts's buildDedupKey-style
  -- helpers at each call site for the exact shape per category.
  dedup_key           VARCHAR(300) NOT NULL,
  recipient_email     VARCHAR(255) NOT NULL,
  lang                VARCHAR(2) NOT NULL DEFAULT 'ar',
  subject             TEXT NOT NULL,
  -- Rendered at enqueue time, not regenerated on retry — a retry must resend
  -- exactly what was originally decided, never re-run business logic that could
  -- have changed underneath it (e.g. a token that already rotated).
  html                TEXT NOT NULL,
  reply_to            VARCHAR(255),
  related_entity_type VARCHAR(50),
  related_entity_id   UUID,
  status              VARCHAR(20) NOT NULL DEFAULT 'queued',
  attempt_count       INT NOT NULL DEFAULT 0,
  max_attempts        INT NOT NULL DEFAULT 5,
  -- Claim/backoff scheduling — a worker only picks up a row once next_attempt_at
  -- has passed. Bumped forward on every temp failure (exponential backoff).
  next_attempt_at     TIMESTAMP NOT NULL DEFAULT now(),
  -- claimed_at/claimed_by exist for observability only (which process/attempt
  -- last touched this row) — the actual atomic claim is the status-guarded
  -- UPDATE itself (see utils/email.ts), not a separate lock check.
  claimed_at          TIMESTAMP,
  claimed_by          VARCHAR(100),
  resend_message_id   VARCHAR(255),
  last_error          TEXT,
  last_attempted_at   TIMESTAMP,
  sent_at             TIMESTAMP,
  delivered_at        TIMESTAMP,
  created_at          TIMESTAMP NOT NULL DEFAULT now(),
  updated_at          TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT email_jobs_dedup_key_unique UNIQUE (dedup_key),
  CONSTRAINT email_jobs_status_check CHECK (status IN (
    'queued', 'processing', 'sent', 'delivered', 'delayed',
    'temp_failed', 'permanently_failed', 'bounced', 'complained',
    'suppressed', 'cancelled',
    -- Our own internal state, not a Resend concept: no RESEND_API_KEY configured
    -- (local dev / before the domain is verified) — content was logged to the
    -- console instead of actually being sent. Kept distinct from 'sent' so the
    -- admin delivery log never shows a dev environment's console-only output as
    -- if it were a real delivery.
    'dev_skipped',
    -- Our own internal state too: a job that was 'processing' when the backend
    -- apparently crashed or restarted, reclaimed by reclaimStuckProcessingJobs()
    -- past the point a same-Idempotency-Key retry can be proven safe (see that
    -- function's comment — Resend retains an Idempotency-Key for 24h). Never
    -- auto-retried; an admin reviews it (checking Resend's own dashboard for
    -- whether it actually sent) before manually retrying via the admin UI.
    'requires_review'
  ))
);

-- Defensive retrofit for a database where email_jobs already existed (created
-- by an earlier run of an older version of this file, before 'requires_review'
-- was added to the allowed status list) -- CREATE TABLE IF NOT EXISTS above is
-- a silent no-op on an existing table, so it can NOT widen an existing CHECK
-- constraint on its own. Unconditionally drop-and-recreate: on a table that
-- was just freshly created above, this simply reapplies the identical
-- constraint (harmless no-op); on a pre-existing table with the older,
-- narrower list, this is what actually retrofits it.
ALTER TABLE email_jobs DROP CONSTRAINT IF EXISTS email_jobs_status_check;
ALTER TABLE email_jobs ADD CONSTRAINT email_jobs_status_check CHECK (status IN (
  'queued', 'processing', 'sent', 'delivered', 'delayed',
  'temp_failed', 'permanently_failed', 'bounced', 'complained',
  'suppressed', 'cancelled', 'dev_skipped', 'requires_review'
));

-- The claim query's own WHERE shape — status IN ('queued','temp_failed') AND
-- next_attempt_at <= now() — so the partial index actually gets used.
CREATE INDEX IF NOT EXISTS idx_email_jobs_claimable
  ON email_jobs (next_attempt_at)
  WHERE status IN ('queued', 'temp_failed');
CREATE INDEX IF NOT EXISTS idx_email_jobs_company_created ON email_jobs (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_jobs_related ON email_jobs (related_entity_type, related_entity_id);
CREATE INDEX IF NOT EXISTS idx_email_jobs_resend_message_id ON email_jobs (resend_message_id);

-- Raw webhook events (Resend delivers these via Svix). svix_id is the header
-- Svix/Resend guarantees is unique per delivery ATTEMPT — retried deliveries of
-- the same logical event reuse it, which is exactly what makes ON CONFLICT DO
-- NOTHING here the idempotency mechanism for webhook processing.
CREATE TABLE IF NOT EXISTS email_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  svix_id           VARCHAR(255) NOT NULL,
  email_job_id      UUID REFERENCES email_jobs(id) ON DELETE SET NULL,
  event_type        VARCHAR(50) NOT NULL,
  resend_message_id VARCHAR(255),
  payload           JSONB NOT NULL,
  received_at       TIMESTAMP NOT NULL DEFAULT now(),
  -- NULL until this event has been resolved one way or another: successfully
  -- correlated to an email_jobs row and applied (or deliberately ignored — an
  -- untracked event type, or a monotonic-status guard blocked it — either
  -- still counts as "resolved"), OR given up on after RECONCILE_GIVE_UP_MS
  -- with no match ever found (email_job_id stays NULL in that case — that
  -- combination, applied_at set + email_job_id NULL, is how an unresolved/
  -- given-up event is told apart from a real match, for audit). Left NULL
  -- only while still genuinely pending: the event arrived before the
  -- matching job row had its resend_message_id written yet (a real race —
  -- the webhook can beat our own write).
  applied_at        TIMESTAMP,
  -- How many times reconcilePendingEmailEvents() has tried and failed to
  -- correlate this event to a job. Drives the backoff on next_reconcile_at
  -- below via the same computeBackoffMs() curve email_jobs retries use.
  reconcile_attempts INT NOT NULL DEFAULT 0,
  -- A pending event is only re-tried once this has passed — defaults to
  -- "now" so a freshly inserted pending event is immediately eligible, and
  -- gets pushed forward on every failed correlation attempt. This (not raw
  -- received_at) is what the reconcile query orders and filters by, which is
  -- what stops a persistently-unmatched old event from permanently sorting
  -- ahead of a newer, genuinely-correlatable one in every batch.
  next_reconcile_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT email_events_svix_id_unique UNIQUE (svix_id)
);

-- Defensive retrofit for a database where email_events already existed from
-- an earlier run of an older version of this file (before applied_at /
-- reconcile_attempts / next_reconcile_at existed) -- see the same reasoning
-- as the email_jobs constraint retrofit above. ADD COLUMN IF NOT EXISTS is a
-- true no-op when the column is already there (the normal case for a table
-- CREATE TABLE just created fresh above), and a real retrofit otherwise.
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS applied_at TIMESTAMP;
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS reconcile_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS next_reconcile_at TIMESTAMP NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_email_events_job ON email_events (email_job_id);
-- The reconcile sweep's own WHERE shape, so it stays a fast index scan even as
-- this table grows.
CREATE INDEX IF NOT EXISTS idx_email_events_unapplied
  ON email_events (next_reconcile_at)
  WHERE applied_at IS NULL AND resend_message_id IS NOT NULL;

-- Defaults every existing row to 'ar' — matches the app's own existing default
-- (frontend/src/store/langStore.ts: "Defaults to Arabic — this is a Kuwait-market
-- product"). No backfill script needed beyond the column default itself.
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(2) NOT NULL DEFAULT 'ar';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_preferred_language_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_preferred_language_check CHECK (preferred_language IN ('ar', 'en'));
  END IF;
END $$;
