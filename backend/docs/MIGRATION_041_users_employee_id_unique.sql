-- Follow-up to MIGRATION_040 (users.employee_id link). Now that Settings > Users gets
-- a UI to set employee_id by hand, add the safety net a UI alone can't guarantee:
-- nothing stops an admin from linking the same employee record to two different
-- login accounts, which would break the "employee sees only their own attendance"
-- guarantee in attendance.controller.ts (both accounts would resolve to the same
-- employee_id and see/act on the same records). Partial unique index — only applies
-- to non-NULL employee_id, so admin/manager accounts with no employee link are unaffected.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_041_users_employee_id_unique.sql

CREATE UNIQUE INDEX IF NOT EXISTS users_employee_id_unique
  ON users (employee_id)
  WHERE employee_id IS NOT NULL;
