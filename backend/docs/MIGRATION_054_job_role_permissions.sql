-- MIGRATION_054_job_role_permissions.sql
--
-- Enterprise RBAC foundation: bulk permission defaults per job role, layered under the
-- existing per-user delegated permissions (MIGRATION_023's user_permissions) rather than
-- replacing them. Effective permission for a user = (their job role's grants) UNION
-- (their own individual grants) — see utils/permissions.ts's hasPermission().
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_054_job_role_permissions.sql
--
-- Design decisions:
--   1. Keyed on job_role_id (FK to job_roles.id from MIGRATION_049), not a job_role text
--      string. employees.job_role stays as-is (free text, still the display value shown
--      everywhere) — job_role_id is a new, separate, nullable link resolved from the same
--      dropdown EmployeesPage.tsx already has (its "Other" free-text fallback simply
--      leaves job_role_id NULL, same nullable pattern as users.employee_id in
--      MIGRATION_040). Matching on the id instead of the string means renaming a job role
--      later (job_roles.name/name_en) never silently desyncs its permission grants.
--   2. company_id carried directly on job_role_permissions, not just reachable via
--      job_role_id -> job_roles.company_id — same defense-in-depth convention job_roles
--      itself follows (MIGRATION_049 decision 5).
--   3. UNIQUE (job_role_id, permission_key) — same shape as user_permissions' own
--      UNIQUE (user_id, permission_key).
--
-- Run again after any migration: safe, IF NOT EXISTS / idempotent throughout.

-- ========================================================================
-- 1. employees.job_role_id — links the existing free-text job_role to a real
--    job_roles row, without touching or dropping the text column.
-- ========================================================================

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS job_role_id UUID REFERENCES job_roles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_employees_job_role_id ON employees (job_role_id);

-- Backfill (best-effort): match an employee's existing job_role text to a job_roles row
-- in the SAME company, by name OR name_en, case-insensitively — but only when that name
-- maps to exactly one job_roles row company-wide. Ambiguous (two departments in the same
-- company happen to have a role with the same name) or unmatched employees are left NULL;
-- a manager re-picks the role from the dropdown by hand (which now also sets job_role_id
-- going forward) rather than this migration guessing wrong on data that will drive
-- permission grants.
UPDATE employees e
SET job_role_id = matched.job_role_id
FROM (
  SELECT company_id, name_norm, MIN(id::text)::uuid AS job_role_id, COUNT(*) AS match_count
  FROM (
    SELECT id, company_id, LOWER(TRIM(name)) AS name_norm FROM job_roles
    UNION ALL
    SELECT id, company_id, LOWER(TRIM(name_en)) AS name_norm FROM job_roles WHERE name_en IS NOT NULL AND TRIM(name_en) <> ''
  ) names
  GROUP BY company_id, name_norm
  HAVING COUNT(*) = 1
) matched
WHERE e.job_role_id IS NULL
  AND e.job_role IS NOT NULL AND TRIM(e.job_role) <> ''
  AND e.company_id = matched.company_id
  AND LOWER(TRIM(e.job_role)) = matched.name_norm;

-- ========================================================================
-- 2. job_role_permissions
-- ========================================================================

CREATE TABLE IF NOT EXISTS job_role_permissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_role_id    UUID NOT NULL REFERENCES job_roles(id) ON DELETE CASCADE,
  permission_key VARCHAR(50) NOT NULL,
  created_at     TIMESTAMP DEFAULT now(),
  UNIQUE (job_role_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_job_role_permissions_company ON job_role_permissions (company_id);
CREATE INDEX IF NOT EXISTS idx_job_role_permissions_role ON job_role_permissions (job_role_id);

-- ========================================================================
-- 3. Seed 2 example grants, matching the roles actually seeded by
--    MIGRATION_049 (that catalog has no literal "CEO"/"CFO" — closest real
--    equivalents already in the data are used instead): 'manage_payroll' to
--    'HR Manager', 'view_profit_margins' to 'Finance Manager'. Idempotent —
--    ON CONFLICT DO NOTHING against the UNIQUE constraint above.
-- ========================================================================

INSERT INTO job_role_permissions (company_id, job_role_id, permission_key)
SELECT jr.company_id, jr.id, 'manage_payroll'
FROM job_roles jr
WHERE jr.name_en = 'HR Manager'
ON CONFLICT (job_role_id, permission_key) DO NOTHING;

INSERT INTO job_role_permissions (company_id, job_role_id, permission_key)
SELECT jr.company_id, jr.id, 'view_profit_margins'
FROM job_roles jr
WHERE jr.name_en = 'Finance Manager'
ON CONFLICT (job_role_id, permission_key) DO NOTHING;
