-- MIGRATION_081_ticket_dual_escalation.sql
--
-- Chat 3D (Stage 5 prerequisite). Three additive, nullable columns on
-- support_tickets:
--   sla_response_escalated_at, sla_resolution_escalated_at  TIMESTAMPTZ
--     — independent per-dimension escalation timestamps. escalation_level
--       and the legacy escalated_to/escalated_at columns are kept and are
--       recomputed from these two whenever either changes (see
--       backend/src/utils/ticketSla.ts's TICKET_UPDATE and
--       supportTickets.controller.ts's updateStatus() reopen branch) — no
--       code path sets escalation_level to a literal number by hand anymore.
--   sla_last_swept_at  TIMESTAMPTZ
--     — internal fairness cursor for sweepTicketSla()'s candidate query
--       (ORDER BY COALESCE(sla_last_swept_at, '-infinity') ASC, ...limit
--       fallback). Prevents the oldest N still-open breached tickets from
--       starving newer ones out of every sweep tick forever. Never surfaced
--       in any UI, report, or API response — purely internal bookkeeping.
--
-- Preflight assumption (REUSED, not re-derived): this migration touches the
-- same support_tickets.escalated_at column, on the same shared, unconfigured
-- pg.Pool, that MIGRATION_080 already investigated and confirmed writes with
-- a UTC session TimeZone (see MIGRATION_080's own preflight note and
-- claude/sla-timezone-incident-2026-09-09.md, project doc). Re-verify before
-- running this file:
--   node scripts/query.js "SELECT current_setting('TimeZone') AS session_timezone, column_name, data_type FROM information_schema.columns WHERE table_name = 'support_tickets' AND column_name = 'escalated_at'"
--   -> session_timezone must be Etc/UTC (UTC-equivalent); escalated_at must
--      still be `timestamp without time zone`. If either differs, STOP —
--      do not run this file.
--
-- Idempotent / safely rerunnable:
--   - All three columns use ADD COLUMN IF NOT EXISTS — a no-op on any re-run
--     after the first successful run.
--   - The one-time legacy backfill (copying pre-Stage-5 escalated_at into
--     sla_response_escalated_at for tickets that had already escalated
--     before Stage 5 existed) is gated on whether sla_response_escalated_at
--     did NOT already exist immediately before this file's own ALTER ran, in
--     THIS transaction — it can only ever fire on that column's first
--     creation. A second run of this file (column already present) skips
--     the backfill block entirely, so it can never re-copy escalated_at into
--     sla_response_escalated_at after Stage 5 has started writing
--     independent, real values into it — which is exactly what would
--     mis-attribute a later resolution-only escalation as a response one if
--     this file were ever re-run post-launch.
--   - sla_last_swept_at has no backfill — every existing row starts NULL,
--     which the candidate query's COALESCE(..., '-infinity') already treats
--     as "never swept, sort first" — the correct starting state.
--   - Column creation and the backfill run inside ONE transaction — either
--     both new-column-related effects land together or neither does.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_081_ticket_dual_escalation.sql
--
-- Post-migration verification (same three-part standard as MIGRATION_080,
-- run and confirmed by Abdullah before any deploy references these columns):
--   1. Column types:
--      node scripts/query.js "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'support_tickets' AND column_name IN ('sla_response_escalated_at','sla_resolution_escalated_at','sla_last_swept_at') ORDER BY column_name"
--      -> all three rows must show data_type = 'timestamp with time zone'.
--   2. Backfill correctness — for every row where escalation_level > 0 AND
--      escalated_at IS NOT NULL, confirm sla_response_escalated_at now holds
--      the identical instant (compare EXTRACT(EPOCH FROM ...) of both
--      columns for those rows — must match exactly, same diff-against-a-
--      pre-migration-snapshot standard MIGRATION_080 used).
--   3. Indexes — confirm pg_indexes for support_tickets is unchanged from
--      immediately before this migration ran.

BEGIN;

DO $$
DECLARE
  response_col_existed boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'support_tickets' AND column_name = 'sla_response_escalated_at'
  ) INTO response_col_existed;

  ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS sla_response_escalated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sla_resolution_escalated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sla_last_swept_at TIMESTAMPTZ;

  -- One-time legacy backfill, first creation only (see header comment).
  -- Every escalation that happened before Stage 5 existed was necessarily a
  -- response-cycle escalation (Stage 5 is what introduces the resolution
  -- dimension) — so escalation_level > 0 AND escalated_at IS NOT NULL,
  -- observed at this exact moment, unambiguously means "response escalated".
  IF NOT response_col_existed THEN
    UPDATE support_tickets
    SET sla_response_escalated_at = escalated_at AT TIME ZONE 'UTC'
    WHERE escalation_level > 0 AND escalated_at IS NOT NULL;
  END IF;
END $$;

COMMIT;
