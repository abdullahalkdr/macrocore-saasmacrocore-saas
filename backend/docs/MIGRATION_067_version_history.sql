-- MIGRATION_067_version_history.sql
--
-- Phase 01 "field-level diffs via version_history" from the Activity Log roadmap.
-- Abdullah's locked scope decision: only for actions already flagged sensitive (see
-- SENSITIVE_ACTIONS in backend/src/utils/audit.ts) — user_role_changed, user_deleted,
-- user_permissions_updated, job_role_permissions_updated, employee_deleted,
-- payroll_generated, payroll_updated, payroll_deleted, payroll_paid — not every
-- action in the app. Storage: a separate table (this one), not reusing audit_logs'
-- own old_values/new_values JSONB columns, so a specific field change ("status:
-- pending -> paid") can be queried/rendered directly instead of diffing two JSON
-- blobs client-side every time.
--
-- audit_log_id is a plain UUID column, NOT a foreign key to audit_logs(id) or
-- audit_logs_archive(id) — deliberately. The row it refers to starts in audit_logs
-- but MIGRATION_065's retention/archiving script moves it (same id, new table) to
-- audit_logs_archive after 12 months. A hard FK to audit_logs(id) would force
-- version_history rows to be deleted (ON DELETE CASCADE) or orphaned the moment
-- their audit_logs row is archived — losing exactly the compliance detail this
-- table exists to keep. Without a hard FK, version_history rows are untouched by
-- archiving and simply keep pointing at the same id, now living in
-- audit_logs_archive. (version_history itself has no archiving/retention story yet
-- — its volume is a small fraction of audit_logs' since only sensitive actions write
-- to it — revisit only if that changes.)
--
-- company_id DOES have a real FK (ON DELETE CASCADE from companies) so Settings >
-- "حذف بيانات المنشأة" still cleans this up along with everything else, same pattern
-- as audit_logs and audit_logs_archive.
--
-- Append-only via the same BEFORE UPDATE OR DELETE trigger pattern as audit_logs
-- (MIGRATION_064) — field-level change history is exactly the kind of record that
-- should never be editable after the fact either.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_067_version_history.sql

CREATE TABLE IF NOT EXISTS version_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_log_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  field_name VARCHAR(100) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_version_history_audit_log ON version_history (audit_log_id);
CREATE INDEX IF NOT EXISTS idx_version_history_company_created ON version_history (company_id, created_at DESC);

REVOKE UPDATE, DELETE ON version_history FROM PUBLIC;

CREATE OR REPLACE FUNCTION version_history_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
      RAISE EXCEPTION 'version_history is append-only — direct DELETE is not allowed';
    END IF;
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'version_history is append-only — UPDATE is not allowed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS version_history_immutable ON version_history;
CREATE TRIGGER version_history_immutable
  BEFORE UPDATE OR DELETE ON version_history
  FOR EACH ROW EXECUTE FUNCTION version_history_block_mutation();
