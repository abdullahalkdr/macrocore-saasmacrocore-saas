-- Closes security audit finding #1: there is no link at all between a login account
-- (users) and an employee's HR record (employees). Because of that:
--   - attendance.controller.ts (clockIn/clockOut) trusted employee_id straight from the
--     request body with no check against the caller's identity — any logged-in user
--     could clock in/out ANY other employee at the same company.
--   - attendance.controller.ts (list) had no per-row ownership filter — any employee
--     could pull every other employee's attendance + payroll deduction history (personal
--     financial data) for the whole company, since attendance.routes.ts only required
--     requireAuth, not a role/ownership guard.
-- This migration only adds the missing link; the controller enforcement is a separate
-- code change (see attendance.controller.ts) that relies on this column existing.
--
-- Nullable on purpose: admin/manager accounts don't necessarily have a matching
-- employees row, and this must not break existing admin/manager logins.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_040_users_employee_link.sql

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES employees(id);

-- Backfill (best-effort, approved approach): link an existing account to its employee
-- record by matching email within the SAME company, case-insensitively — but only when
-- that email maps to exactly one employees row in that company. Ambiguous (duplicate
-- email under the same company) or unmatched accounts are deliberately left NULL; a
-- manager links those by hand later rather than this migration guessing wrong on
-- data that feeds payroll deductions.
UPDATE users u
SET employee_id = matched.employee_id
FROM (
  SELECT
    e.company_id,
    LOWER(TRIM(e.email)) AS email_norm,
    MIN(e.id) AS employee_id,
    COUNT(*) AS match_count
  FROM employees e
  WHERE e.email IS NOT NULL AND TRIM(e.email) <> ''
  GROUP BY e.company_id, LOWER(TRIM(e.email))
  HAVING COUNT(*) = 1
) matched
WHERE u.employee_id IS NULL
  AND u.company_id = matched.company_id
  AND LOWER(TRIM(u.email)) = matched.email_norm;

-- After running, check how many accounts still need manual linking:
--   SELECT id, email, company_id, role FROM users
--   WHERE role = 'employee' AND employee_id IS NULL;
