-- MIGRATION_073_employee_direct_manager.sql
--
-- Adds a per-employee "reports to" link — the missing third tier in the
-- department-scope work from 2026-08-29 (see
-- claude/manager-scope-department-based-decision.md). Until now, HR-scope
-- authorization only understood two organizational shapes: the whole
-- company (admin / HR-department full scope) or a whole department
-- (role='manager' with a department, or departments.manager_id — "Department
-- Head"). There was no way to say "this specific person manages these
-- specific people" independent of any department structure — a "Direct
-- Manager" in the user's own terms (e.g. a Safety & Security manager who
-- should see only his own direct reports, nothing department- or-- company-wide).
--
-- Design, decided with the user via AskUserQuestion:
--   1. Direct reports only, NOT recursive — employees.manager_id points to--      exactly one other employee (their direct manager). A Direct--      Manager's scope is the flat set of employees whose manager_id--      equals their own employee id — not a multi-level subtree. (Multi---      level "see my reports' reports too" can be added later as a--      recursive walk, same shape as departmentAndDescendantIds(), if the--      user wants it — deliberately kept simple for v1.)
--   2. Same pattern as every other manager_id column in this schema--      (departments.manager_id, cost_centers.manager_id, locations.--      manager_id, projects.manager_id): a plain FK to employees(id),--      cross-tenant (same-company) validation done at the application--      layer (assertValidManager-style check), not enforced by the FK--      itself.
--   3. CHECK (manager_id IS NULL OR manager_id <> id) — an employee cannot--      be their own direct manager. Cycles longer than 1 hop (A reports to--      B, B reports to A) are NOT prevented at the DB level (same as--      departments.parent_department_id has no cycle guard either) —--      application code that walks this chain must guard with a `seen`--      set, same convention as hrScope.ts's isWithinDepartmentCategory().
--
-- Nullable and optional: an employee with no manager_id behaves exactly as-- before this migration (nobody's "Direct Manager" scope grows from them).
--
-- Idempotent throughout — safe to re-run.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_073_employee_direct_manager.sql

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES employees(id) ON DELETE SET NULL;

DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'employees'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%manager_id%';
  IF con_name IS NULL THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_manager_id_not_self CHECK (manager_id IS NULL OR manager_id <> id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_employees_manager_id ON employees (manager_id);
