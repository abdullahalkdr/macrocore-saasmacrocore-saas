-- MIGRATION_075_policy_permission_gates_fixes.sql
-- Corrective migration for MIGRATION_074, applied before any application code
-- (Step 2) writes to either table. Confirmed via live read-only queries (2026-09-05):
-- both policy_permission_gates and pending_permission_grants exist and are empty
-- (0 rows) — every change below is a plain structural fix, no data cleanup needed.
-- Run with: node scripts/run-sql.js docs/MIGRATION_075_policy_permission_gates_fixes.sql
--
-- Scope (locked with Abdullah, pilot-only):
--   1. created_by (policy_permission_gates) and requested_by
--      (pending_permission_grants) go from the implicit NO ACTION (MIGRATION_074 left
--      them as plain "REFERENCES users(id)") to ON DELETE SET NULL — deleting the
--      admin who made the link/request no longer blocks their own account deletion
--      (users.controller.ts's remove() does a real DELETE FROM users with no
--      pre-check); the gate/request row itself survives, it just loses "who did it".
--      Does NOT touch policies.created_by/reviewed_by/approved_by (MIGRATION_044) —
--      that has the same underlying gap but is a separate, already-shipped module,
--      explicitly out of scope for this pilot.
--   2. policy_permission_gates' uniqueness narrows from (company_id, policy_id,
--      permission_key) to (company_id, permission_key) — enforces exactly one policy
--      per permission_key per company. No "any/all" multi-policy logic — one key, one
--      policy, by construction.
--   3. Drops 4 indexes that are pure duplicates of what a UNIQUE constraint's own
--      auto-created index already covers via leftmost-prefix matching: the composite
--      unique index backing fix #2 already serves "by company_id" and "by company_id +
--      permission_key" lookups on policy_permission_gates on its own; the pending
--      table's existing 3-column unique index (company_id, user_id, permission_key)
--      already serves "by company_id" and "by company_id + user_id" the same way.
--      idx_pending_permission_grants_policy is kept as-is — policy_id isn't a prefix
--      of that unique index, it's a genuinely separate lookup path (finding/cancelling
--      pending requests when their policy leaves 'approved').

-- ---------------------------------------------------------------------
-- 1. created_by / requested_by -> ON DELETE SET NULL
-- Both were unnamed inline "REFERENCES users(id)" in MIGRATION_074, so Postgres
-- auto-named the constraints. Looked up dynamically via pg_constraint instead of
-- hardcoding a guessed name — same defensive pattern MIGRATION_045 already used in
-- this codebase for policies.module_linked's CHECK constraint.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE t.relname = 'policy_permission_gates'
      AND c.contype = 'f'
      AND a.attname = 'created_by'
  LOOP
    EXECUTE format('ALTER TABLE policy_permission_gates DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE policy_permission_gates
  ADD CONSTRAINT policy_permission_gates_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE t.relname = 'pending_permission_grants'
      AND c.contype = 'f'
      AND a.attname = 'requested_by'
  LOOP
    EXECUTE format('ALTER TABLE pending_permission_grants DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE pending_permission_grants
  ADD CONSTRAINT pending_permission_grants_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- 2. One policy per permission_key per company (named constraint from MIGRATION_074,
--    dropped and replaced directly — no dynamic lookup needed, the name is certain).
-- ---------------------------------------------------------------------

ALTER TABLE policy_permission_gates DROP CONSTRAINT IF EXISTS uq_policy_permission_gate;
ALTER TABLE policy_permission_gates
  ADD CONSTRAINT uq_policy_permission_gate UNIQUE (company_id, permission_key);

-- ---------------------------------------------------------------------
-- 3. Drop redundant indexes (each fully covered by a UNIQUE constraint's own
--    auto-created index via leftmost-prefix matching). Names are certain — all were
--    explicitly created by MIGRATION_074.
-- ---------------------------------------------------------------------

DROP INDEX IF EXISTS idx_policy_permission_gates_company;
DROP INDEX IF EXISTS idx_policy_permission_gates_key;
DROP INDEX IF EXISTS idx_pending_permission_grants_company;
DROP INDEX IF EXISTS idx_pending_permission_grants_user;

-- idx_pending_permission_grants_policy is intentionally left untouched.
