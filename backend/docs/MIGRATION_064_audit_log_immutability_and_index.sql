-- MIGRATION_064_audit_log_immutability_and_index.sql
--
-- Two changes for the Activity Log roadmap's first sprint. Pagination and the
-- sensitive-action classification are pure backend/frontend code (see
-- auditLog.controller.ts) — this migration only covers the two things that
-- actually need a database change:
--
--   1. An index so real pagination (offset/limit, added in this same change set)
--      doesn't degrade into a full table scan as audit_logs grows into the
--      millions of rows the roadmap assumes.
--
--   2. True immutability: audit_logs becomes append-only at the database level,
--      not just "the UI doesn't have an edit button."
--
--      Why a trigger, not a plain REVOKE:
--      REVOKE UPDATE/DELETE has NO EFFECT on a table's OWNER — in Postgres, table
--      ownership carries implicit full privileges that REVOKE cannot remove. On a
--      typical managed Postgres (Railway included), the single database role the
--      backend connects as is almost always also the table's owner — a REVOKE-only
--      migration would silently do nothing and give false confidence the table is
--      protected. A BEFORE UPDATE/DELETE trigger has no such loophole: it fires for
--      every role, owner included, and the only way around it is an explicit
--      `ALTER TABLE ... DISABLE TRIGGER`, which is a loud, deliberate schema change,
--      not a silent data mutation.
--
--      One real interaction had to be accounted for: Settings > "حذف بيانات
--      المنشأة" (company.controller.ts, deleteMe) lets a company delete its own
--      account, and relies on audit_logs' existing ON DELETE CASCADE from
--      companies(id) to clear its trail along with everything else. A blanket
--      "block every DELETE" trigger would break that flow outright. The trigger
--      below allows a DELETE only when the row's owning company no longer exists —
--      true for that cascade (the parent company row is already gone earlier in
--      the same transaction by the time the cascade reaches audit_logs), false for
--      any direct DELETE attempted against a still-live company's rows.
--
--      The REVOKE ... FROM PUBLIC statement is added anyway as free defense in
--      depth for any role that ISN'T the table owner (a future read-replica role,
--      a reporting user, etc.) — it costs nothing, even though the trigger is what
--      actually stops the app's own connection.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_064_audit_log_immutability_and_index.sql

-- 1. Pagination index
CREATE INDEX IF NOT EXISTS idx_audit_logs_company_created
  ON audit_logs (company_id, created_at DESC);

-- 2. Immutability
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;

CREATE OR REPLACE FUNCTION audit_logs_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
      RAISE EXCEPTION 'audit_logs is append-only — direct DELETE is not allowed';
    END IF;
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only — UPDATE is not allowed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_immutable ON audit_logs;
CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
