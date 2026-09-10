-- MIGRATION_080_ticket_sla_timestamptz.sql
--
-- Chat 3B, Stage 0 — same bug class as MIGRATION_079 (see
-- claude/sla-timezone-incident-2026-09-09.md, project doc), applied to
-- support_tickets instead of approval_requests. MIGRATION_043 added
-- sla_response_due_at / sla_resolution_due_at as TIMESTAMP WITHOUT TIME
-- ZONE. Postgres sends that type over the wire with no offset, and
-- node-postgres's default parser for it (OID 1114) builds the resulting JS
-- Date from the raw wall-clock digits interpreted in the CONNECTING
-- PROCESS's own local timezone — not UTC. No background scheduler reads
-- these two columns today (support_tickets' SLA sweep is still the lazy,
-- request-time-only sweep in supportTickets.controller.ts's slaReport() —
-- see claude/chat3-helpdesk-itsm-handoff-brief-2026-09-09.md §7.3), so nothing
-- is currently exposed to the exact incident mechanism. This migration is a
-- prerequisite for Stage 5's planned sweepTicketSla() background sweep
-- (Chat 3B), which — once it exists — would compare these columns against a
-- freshly-computed NOW() from a separate scheduler tick, the same shape of
-- cross-process comparison that broke approval_requests.
--
-- This migration converts ONLY sla_response_due_at and sla_resolution_due_at
-- on support_tickets to TIMESTAMPTZ. It does NOT touch first_response_at,
-- resolved_at, or escalated_at (also still TIMESTAMP WITHOUT TIME ZONE on
-- this table) — those are logged as separate, out-of-scope timezone debt
-- for Chat 3B (they're written and read synchronously within the same
-- request today, with no cross-process comparison path, so they don't carry
-- the incident's specific risk; a display-correctness gap only, not a
-- scheduler-correctness one). Do not extend this migration to cover them
-- without a separate, explicit decision.
--
-- "AT TIME ZONE 'UTC'" in each USING clause is deliberate, not decorative:
-- it forces the EXISTING stored wall-clock values to be interpreted as
-- already being UTC (matching how they were actually written — NOW() cast
-- on this database's session, whose TimeZone is UTC), rather than depending
-- on whatever TimeZone setting happens to be active on the session that
-- runs this migration.
--
-- Preflight (run and confirmed before this file was written — Chat 3B):
--   node scripts/query.js "SELECT current_setting('TimeZone') AS session_timezone, column_name, data_type FROM information_schema.columns WHERE table_name = 'support_tickets' AND column_name IN ('sla_response_due_at','sla_resolution_due_at') ORDER BY column_name"
--     -> session_timezone = Etc/UTC (UTC-equivalent); both columns
--        timestamp without time zone. Confirmed. A full pre-migration
--        epoch snapshot (25 rows, including historical witness ticket
--        GEN-2609-0001) was captured and preserved in Chat 3B before this
--        file was written — see the AFTER query below for the matching
--        comparison to run post-migration.
--
-- If a re-run of the preflight query ever shows session_timezone as
-- anything other than UTC/Etc-UTC, STOP — do not run this file. The
-- AT TIME ZONE 'UTC' USING clauses below assume every session that has
-- ever written these two columns used a UTC session TimeZone; see this
-- migration's own Chat 3B discussion for the evidence behind that
-- assumption (single shared, unconfigured pg.Pool in backend/src/db/pool.ts
-- — no SET TIME ZONE / PGTZ / per-connection timezone override anywhere in
-- the backend — so support_tickets writes share the identical session
-- TimeZone default already established for approval_requests during the
-- original incident investigation).
--
-- Idempotent / safely rerunnable:
--   - Each column converts ONLY if its current type is still
--     `timestamp without time zone` (checked via information_schema right
--     before converting). Running this migration again after it already
--     succeeded is a no-op — re-applying `AT TIME ZONE 'UTC'` to a column
--     that is already TIMESTAMPTZ would silently shift every value by the
--     session's offset, which is exactly the class of bug this migration
--     exists to fix, so the type check is not optional.
--   - Both columns convert inside ONE transaction — either both succeed or
--     neither does; there is no partial (one TIMESTAMPTZ, one still
--     TIMESTAMP) state possible from a single run of this file.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_080_ticket_sla_timestamptz.sql
--
-- Post-migration verification (all three, not assumed from a clean run):
--
--   1. Column types:
--      node scripts/query.js "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'support_tickets' AND column_name IN ('sla_response_due_at','sla_resolution_due_at') ORDER BY column_name"
--      -> both rows must show data_type = 'timestamp with time zone'
--
--   2. No instant shifted — re-run the exact epoch query and diff row-by-row
--      against the pre-migration snapshot already preserved in Chat 3B
--      (25 rows, GEN-2609-0001 included):
--      node scripts/query.js "SELECT id, ticket_number, EXTRACT(EPOCH FROM sla_response_due_at) AS resp_epoch, EXTRACT(EPOCH FROM sla_resolution_due_at) AS reso_epoch FROM support_tickets WHERE sla_response_due_at IS NOT NULL OR sla_resolution_due_at IS NOT NULL ORDER BY id"
--      -> resp_epoch/reso_epoch must be identical, per row, to the
--         pre-migration snapshot's values. Any mismatch on any row —
--         GEN-2609-0001 included — means STOP and investigate before
--         anything else touches this table; do not proceed to Stage 1.
--
--   3. Indexes — confirm nothing on support_tickets looks different/missing
--      after the rewrite (defensive; no index was found defined on either
--      column across the migrations reviewed in Chat 3B, but that review
--      was not exhaustive across every one of MIGRATION_001-079):
--      node scripts/query.js "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'support_tickets' ORDER BY indexname"
--      -> compare against the same query run BEFORE this migration; the set
--         of index names must be unchanged.

BEGIN;

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'support_tickets' AND column_name = 'sla_response_due_at') = 'timestamp without time zone' THEN
    ALTER TABLE support_tickets
      ALTER COLUMN sla_response_due_at TYPE TIMESTAMPTZ USING sla_response_due_at AT TIME ZONE 'UTC';
  END IF;

  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'support_tickets' AND column_name = 'sla_resolution_due_at') = 'timestamp without time zone' THEN
    ALTER TABLE support_tickets
      ALTER COLUMN sla_resolution_due_at TYPE TIMESTAMPTZ USING sla_resolution_due_at AT TIME ZONE 'UTC';
  END IF;
END $$;

COMMIT;
