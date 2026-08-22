-- MIGRATION_045_expand_policy_modules.sql
-- Adds 5 global/standard policy categories to policies.module_linked, plus 'other'.
-- Run with: node scripts/run-sql.js docs/MIGRATION_045_expand_policy_modules.sql
--
-- module_linked has no explicit constraint name in MIGRATION_044 (inline CHECK), so
-- Postgres auto-named it — rather than hardcode a guessed name, this finds whatever
-- CHECK constraint currently mentions module_linked and drops it before re-adding the
-- expanded list under an explicit name. Re-runnable: a second run just finds the
-- explicitly-named constraint from the first run and replaces it with itself.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'policies'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%module_linked%'
  LOOP
    EXECUTE format('ALTER TABLE policies DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE policies
  ADD CONSTRAINT policies_module_linked_check
  CHECK (module_linked IS NULL OR module_linked IN (
    -- original 5 (MIGRATION_044)
    'pos_shifts', 'expenses_waste', 'inventory_supply_chain', 'hr_payroll', 'reports',
    -- new global/standard categories
    'health_safety', 'data_privacy', 'customer_service', 'code_of_conduct', 'other'
  ));

-- VARCHAR(30) from MIGRATION_044 already fits every new value (longest is
-- 'customer_service' at 17 chars) — no column-width change needed.
