-- MIGRATION_070_backfill_it_section_codes.sql
--
-- BUGFIX for MIGRATION_069's IT Department Template: the 22 internal
-- sections it creates (children of the 8 IT divisions) originally got no
-- `departments.code` at all. That silently degraded MIGRATION_057's ticket
-- smart-numbering — generateTicketNumber() resolves the [DEPT] prefix
-- strictly from the REQUESTER'S OWN department row's `code`
-- (supportTickets.controller.ts), not from any parent department, so an
-- employee placed at the more natural, specific section level (e.g.
-- "Networking & Telecom" rather than the "IT Infrastructure & Networks"
-- division itself) silently fell back to the generic 'GEN-...' ticket
-- prefix instead of an IT one. backend/src/utils/itDepartmentTemplate.ts is
-- already fixed so every future template application (new signups, or an
-- admin re-running "Load IT Department Template") sets it correctly; this
-- migration is the one-time backfill for any company that already applied
-- the template before that fix (confirmed at least one — Abdullah's own
-- test run on 2026-08-26).
--
-- Purely additive: only fills a NULL `code` on a department whose parent is
-- one of the template's 8 divisions and whose own code isn't already set —
-- never touches name/status/employees/job_roles, nothing to roll back.
-- Idempotent — a second run updates zero rows.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_070_backfill_it_section_codes.sql

UPDATE departments AS section
SET code = parent.code
FROM departments AS parent
WHERE section.parent_department_id = parent.id
  AND section.company_id = parent.company_id
  AND section.code IS NULL
  AND parent.code IN ('IT-EXEC', 'IT-INFRA', 'IT-APPS', 'IT-SEC', 'IT-SD', 'IT-PMO', 'IT-DATA', 'IT-DX');
