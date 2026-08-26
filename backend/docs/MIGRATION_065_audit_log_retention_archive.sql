-- MIGRATION_065_audit_log_retention_archive.sql
--
-- Phase 00 "Retention" from the Activity Log roadmap. Abdullah's locked decision:
-- keep full-detail audit_logs rows for 12 months, then move them to a cold archive
-- table rather than deleting them outright.
--
-- What this migration does:
--   1. Creates audit_logs_archive — same shape as audit_logs (plus archived_at), same
--      ON DELETE CASCADE from companies(id) so Settings > "حذف بيانات المنشأة" still
--      clears everything, archived history included.
--   2. Adds its own append-only trigger — deliberately STRICTER than the live
--      table's. The archive never gets an age-based delete exception: once a row
--      lands here, the only way it leaves is the same "company no longer exists"
--      cascade case as the live table. Reusing the live table's exception here
--      as-is would let the archive immediately start deleting its own oldest rows,
--      which defeats the entire point of having an archive.
--   3. Updates the LIVE table's trigger (audit_logs_block_mutation, from
--      MIGRATION_064) to add exactly one new allowed case: DELETE of a row older
--      than the 12-month retention window, for a company that still exists. This is
--      what lets the archiving script actually move old rows out of the live table.
--      Everything inside the 12-month window stays exactly as protected as
--      MIGRATION_064 made it — no exception for recent rows, ever, regardless of who
--      issues the DELETE.
--
-- The actual move (INSERT into archive + DELETE from live, batched, one transaction
-- per batch) is a standalone script — backend/scripts/archive-old-audit-logs.js —
-- not a database job. This app has no in-process scheduler and no cron dependency
-- today, so this follows the existing backend/scripts/*.js convention (same pattern
-- as migrate.js, run-sql.js) instead of introducing one. Abdullah needs to schedule
-- that script to run periodically (e.g. a Railway Cron Job service, monthly) — see
-- its own header comment for the exact run command.
--
-- RETENTION_MONTHS is hardcoded as 12 in two places that must be kept in sync if it
-- ever changes: the INTERVAL below, and archive-old-audit-logs.js's own constant.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_065_audit_log_retention_archive.sql

CREATE TABLE IF NOT EXISTS audit_logs_archive (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  action VARCHAR(50),
  entity_type VARCHAR(50),
  entity_id UUID,
  old_values JSONB,
  new_values JSONB,
  ip_address VARCHAR(50),
  user_agent VARCHAR(500),
  created_at TIMESTAMP,
  archived_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION audit_logs_archive_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
      RAISE EXCEPTION 'audit_logs_archive is append-only — direct DELETE is not allowed';
    END IF;
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'audit_logs_archive is append-only — UPDATE is not allowed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_archive_immutable ON audit_logs_archive;
CREATE TRIGGER audit_logs_archive_immutable
  BEFORE UPDATE OR DELETE ON audit_logs_archive
  FOR EACH ROW EXECUTE FUNCTION audit_logs_archive_block_mutation();

-- Live table: same function name as MIGRATION_064 (CREATE OR REPLACE updates the
-- existing trigger's behavior in place — no need to touch the trigger object itself).
CREATE OR REPLACE FUNCTION audit_logs_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
      IF OLD.created_at >= NOW() - INTERVAL '12 months' THEN
        RAISE EXCEPTION 'audit_logs is append-only — direct DELETE within the 12-month retention window is not allowed';
      END IF;
      -- Older than the retention window, company still exists: this is the
      -- archiving script's path (it always INSERTs into audit_logs_archive first,
      -- in the same transaction as this DELETE).
      RETURN OLD;
    END IF;
    -- Company no longer exists: unchanged cascade case from MIGRATION_064.
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only — UPDATE is not allowed';
END;
$$ LANGUAGE plpgsql;
