-- MIGRATION_079_approval_sla_timestamptz.sql
--
-- Fixes a real production incident (2026-09-09) — see
-- claude/sla-timezone-incident-2026-09-09.md (project doc) for the full
-- root-cause evidence. MIGRATION_078 added sla_deadline_at /
-- sla_reminder_sent_at / sla_breached_at as TIMESTAMP WITHOUT TIME ZONE.
-- Postgres sends that type over the wire with no offset, and node-postgres's
-- default parser for it (OID 1114) builds the resulting JS Date from the raw
-- wall-clock digits interpreted in the CONNECTING PROCESS's own local
-- timezone — not UTC. A local dev backend (Asia/Kuwait, UTC+3) and the real
-- Railway deployment (UTC) therefore computed two different instants — 3h
-- apart — from the exact same stored row, and the local process's sweep
-- broke it as "already breached" 3 hours early.
--
-- This migration converts all three columns to TIMESTAMPTZ, which Postgres
-- always sends with an explicit UTC offset — every client then reads the
-- same row identically regardless of its own local timezone.
--
-- "AT TIME ZONE 'UTC'" in each USING clause is deliberate, not decorative:
-- it forces the EXISTING stored wall-clock values to be interpreted as
-- already being UTC (matching how they were actually written — NOW() cast
-- on this database's session, whose TimeZone is UTC), rather than depending
-- on whatever TimeZone setting happens to be active on the session that
-- runs this migration.
--
-- Idempotent / safely rerunnable:
--   - Each column converts ONLY if its current type is still
--     `timestamp without time zone` (checked via information_schema right
--     before converting). Running this migration again after it already
--     succeeded is a no-op — re-applying `AT TIME ZONE 'UTC'` to a column
--     that is already TIMESTAMPTZ would silently shift every value by the
--     session's offset, which is exactly the class of bug this migration
--     exists to fix, so the type check is not optional.
--   - All three columns convert inside ONE transaction — either all three
--     succeed or none do; there is no partial (two TIMESTAMPTZ, one still
--     TIMESTAMP) state possible from a single run of this file.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_079_approval_sla_timestamptz.sql
--
-- Verify afterward (both must be re-checked, not assumed from a clean run):
--   node scripts/query.js "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'approval_requests' AND column_name IN ('sla_deadline_at','sla_reminder_sent_at','sla_breached_at') ORDER BY column_name"
--     -> all three rows must show data_type = 'timestamp with time zone'
--   node scripts/query.js "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'approval_requests' AND indexname = 'idx_approval_requests_sla_pending'"
--     -> idx_approval_requests_sla_pending must still exist (Postgres rebuilds
--        a dependent index automatically on ALTER COLUMN TYPE, but this
--        confirms it rather than assuming it)

BEGIN;

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'approval_requests' AND column_name = 'sla_deadline_at') = 'timestamp without time zone' THEN
    ALTER TABLE approval_requests
      ALTER COLUMN sla_deadline_at TYPE TIMESTAMPTZ USING sla_deadline_at AT TIME ZONE 'UTC';
  END IF;

  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'approval_requests' AND column_name = 'sla_reminder_sent_at') = 'timestamp without time zone' THEN
    ALTER TABLE approval_requests
      ALTER COLUMN sla_reminder_sent_at TYPE TIMESTAMPTZ USING sla_reminder_sent_at AT TIME ZONE 'UTC';
  END IF;

  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'approval_requests' AND column_name = 'sla_breached_at') = 'timestamp without time zone' THEN
    ALTER TABLE approval_requests
      ALTER COLUMN sla_breached_at TYPE TIMESTAMPTZ USING sla_breached_at AT TIME ZONE 'UTC';
  END IF;
END $$;

COMMIT;
