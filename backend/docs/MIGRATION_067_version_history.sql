-- MIGRATION_067_version_history.sql
--
-- Phase 01 "field-level diffs via a dedicated table" from the Activity Log roadmap.
-- Abdullah's locked scope decision: only for actions already flagged sensitive (see
-- SENSITIVE_ACTIONS in backend/src/utils/audit.ts) — user_role_changed, user_deleted,
-- user_permissions_updated, job_role_permissions_updated, employee_deleted,
-- payroll_generated, payroll_updated, payroll_deleted, payroll_paid — not every
-- action in the app. Storage: a separate table (this one), not reusing audit_logs'
-- own old_values/new_values JSONB columns, so a specific field change ("status:
-- pending -> paid") can be queried/rendered directly instead of diffing two JSON
-- blobs client-side every time.
--
-- NAMED audit_log_field_changes, NOT version_history — this schema ALREADY has an
-- unrelated table called version_history (table_name, record_id, version, changed_by,
-- reason — generic multi-table version/sync scaffolding referenced by
-- sync.controller.ts, not written to by anything yet, and NOT the same shape as this
-- one at all). The first attempt at this migration used the name version_history and
-- failed on a live run: `CREATE TABLE IF NOT EXISTS version_history (...)` silently
-- no-opped against the pre-existing table instead of creating this one, and the very
-- next statement (an index on a column that table doesn't have) errored out
-- (`column "audit_log_id" does not exist`, 42703). Because run-sql.js sends the whole
-- file as one multi-statement query, Postgres rolled back everything in it — nothing
-- was left half-applied. This corrected version uses a distinct name so there's no
-- collision to silently no-op against.
--
-- audit_log_id is a plain UUID column, NOT a foreign key to audit_logs(id) or
-- audit_logs_archive(id) — deliberately. The row it refers to starts in audit_logs
-- but MIGRATION_065's retention/archiving script moves it (same id, new table) to
-- audit_logs_archive after 12 months. A hard FK to audit_logs(id) would force
-- audit_log_field_changes rows to be deleted (ON DELETE CASCADE) or orphaned the
-- moment their audit_logs row is archived — losing exactly the compliance detail
-- this table exists to keep. Without a hard FK, these rows are untouched by
-- archiving and simply keep pointing at the same id, now living in
-- audit_logs_archive. (This table itself has no archiving/retention story yet — its
-- volume is a small fraction of audit_logs' since only sensitive actions write to
-- it — revisit only if that changes.)
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

CREATE TABLE IF NOT EXISTS audit_log_field_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_log_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  field_name VARCHAR(100) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_field_changes_audit_log ON audit_log_field_changes (audit_log_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_field_changes_company_created ON audit_log_field_changes (company_id, created_at DESC);

REVOKE UPDATE, DELETE ON audit_log_field_changes FROM PUBLIC;

CREATE OR REPLACE FUNCTION audit_log_field_changes_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
      RAISE EXCEPTION 'audit_log_field_changes is append-only — direct DELETE is not allowed';
    END IF;
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'audit_log_field_changes is append-only — UPDATE is not allowed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_field_changes_immutable ON audit_log_field_changes;
CREATE TRIGGER audit_log_field_changes_immutable
  BEFORE UPDATE OR DELETE ON audit_log_field_changes
  FOR EACH ROW EXECUTE FUNCTION audit_log_field_changes_block_mutation();
