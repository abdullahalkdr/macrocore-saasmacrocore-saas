-- MIGRATION_069_it_department_template.sql
--
-- Adds a per-job-role reference-text column so the new "IT Department
-- Template" feature (backend/src/utils/itDepartmentTemplate.ts) can attach a
-- real-world responsibilities blurb to every job title it creates. This is
-- descriptive/reference text only, per the design decision recorded in
-- claude/it-department-structure-context-handoff.md section 4 (Q3): most of
-- the template is organizational data, not a new pile of enforced
-- PERMISSION_KEYS with no matching route check behind them. A handful of
-- senior/security-facing roles are additionally linked to the *existing*
-- job_role_permissions table with a real, already-wired PERMISSION_KEYS
-- entry (view_audit_log, manage_system_settings, export_sensitive_reports) —
-- no schema change needed for that part, job_role_permissions already exists
-- from MIGRATION_054.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_069_it_department_template.sql

ALTER TABLE job_roles
  ADD COLUMN IF NOT EXISTS responsibilities TEXT;
