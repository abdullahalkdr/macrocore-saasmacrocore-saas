-- MIGRATION_063_audit_log_it_permissions.sql
--
-- Grants the new 'view_audit_log' permission key (added in the same change set —
-- see PERMISSION_KEYS in permissions.controller.ts, and requireRoleOrPermission
-- wired into auditLog.routes.ts) to the 5 job roles already seeded under every
-- company's IT department by MIGRATION_049: IT Manager, Software Developer,
-- IT Support Specialist, Systems Administrator, Network Engineer.
--
-- Context: Abdullah asked that IT staff (and their manager) see every entry in
-- the Activity Log without being admin/manager. "Their manager" was clarified to
-- mean the IT Manager job role specifically — already one of the 5 above, so no
-- separate grant is needed for it. Company-wide "supervisors" access was
-- explicitly deferred to a later pass, not included here.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_063_audit_log_it_permissions.sql
--
-- Design decisions:
--   1. Same shape as MIGRATION_054 section 3 (its 'manage_payroll' -> 'HR Manager'
--      example grant): matched by job_roles.name_en, applied across every company
--      that has that role, not scoped to one company_id. A company without an IT
--      department (or without these exact role names) simply matches zero rows —
--      no error, nothing to guard.
--   2. ON CONFLICT (job_role_id, permission_key) DO NOTHING — idempotent, safe to
--      re-run.

INSERT INTO job_role_permissions (company_id, job_role_id, permission_key)
SELECT jr.company_id, jr.id, 'view_audit_log'
FROM job_roles jr
WHERE jr.name_en IN (
  'IT Manager',
  'Software Developer',
  'IT Support Specialist',
  'Systems Administrator',
  'Network Engineer'
)
ON CONFLICT (job_role_id, permission_key) DO NOTHING;
