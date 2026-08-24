-- MIGRATION_056_multistep_approval_engine.sql
--
-- Upgrades the single-step Approval Engine (MIGRATION_055) to support sequential
-- multi-step chains, and defines the first real multi-step workflow: the ITSM/Helpdesk
-- ticketing module's 3-tier IT Support & Permission Request flow —
--   1. Direct (department) manager approves.
--   2. The ticket's assigned IT agent actions it.
--   3. The IT Manager gives final approval, closing the loop.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_056_multistep_approval_engine.sql
--
-- Design decisions:
--   1. approval_workflow_steps is a GLOBAL definition table (no company_id) — the step
--      sequence for a given module_type is a fixed business process defined by this
--      engine's code, not yet a per-company-configurable workflow builder. A future
--      migration can add company_id + an admin UI on top of this same table without
--      changing its shape; today every company that reaches Gold tier gets the same
--      3-step ITSM chain.
--   2. approver_type is one of three resolution strategies, each resolved live at
--      read/action time (backend/src/utils/itsmApprovals.ts), never frozen onto the
--      approval_requests row itself:
--        - 'department_manager': the ticket requester's employees.department_id ->
--          departments.manager_id (MIGRATION_049). No company_id column needed here —
--          approver_value is NULL, the requester's own row supplies everything.
--        - 'ticket_assignee': support_tickets.assigned_to for THIS ticket, read live —
--          so re-assigning a ticket after it reaches step 2 correctly redirects
--          eligibility to the new assignee without touching approval_requests at all.
--        - 'job_role': approver_value names a job_roles.name_en to match against, via
--          employees.job_role_id (MIGRATION_054) — 'IT Manager' for step 3, matching
--          the job role MIGRATION_049 already seeds under the IT department.
--      Every resolution strategy falls back to "any admin/manager may act" when it
--      can't resolve a specific person (no department set, no manager assigned, ticket
--      unassigned, nobody holds the named job role yet) — see isEligible() in the same
--      util file. A workflow with an unstaffed step must never permanently strand a
--      ticket; admin is also always allowed to act on any step regardless, as a
--      universal safety valve (same "prevent lockout" principle already applied to the
--      Sidebar's admin fallback).
--   3. No changes to approval_requests/approval_steps_log — current_step already
--      existed for exactly this purpose (MIGRATION_055's decision #3), and status's
--      existing CHECK (pending/approved/rejected/cancelled) already covers a
--      multi-step chain: 'pending' covers every intermediate step, not just step 1;
--      the row only flips to 'approved' once the FINAL step is approved. A rejection
--      at ANY step stops the whole chain immediately (status = 'rejected'), it does
--      not partially roll back to a prior step.
--   4. Still explicitly NOT wiring Payroll or Purchase Orders to any of this — both
--      keep their existing MIGRATION_055 single-step behavior untouched. Only
--      module_type = 'ITSM_TICKET' is multi-step as of this migration.
--
-- Run again after any migration: safe, IF NOT EXISTS / idempotent throughout.

CREATE TABLE IF NOT EXISTS approval_workflow_steps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_type     VARCHAR(50) NOT NULL,
  step_number     INT NOT NULL,
  approver_type   VARCHAR(30) NOT NULL
                    CHECK (approver_type IN ('department_manager', 'ticket_assignee', 'job_role')),
  approver_value  VARCHAR(120),
  step_label      VARCHAR(120) NOT NULL,
  step_label_en   VARCHAR(120),
  UNIQUE (module_type, step_number)
);

INSERT INTO approval_workflow_steps (module_type, step_number, approver_type, approver_value, step_label, step_label_en) VALUES
  ('ITSM_TICKET', 1, 'department_manager', NULL,          'موافقة المدير المباشر',        'Direct manager approval'),
  ('ITSM_TICKET', 2, 'ticket_assignee',     NULL,          'إجراء وكيل تقنية المعلومات',    'IT agent action'),
  ('ITSM_TICKET', 3, 'job_role',            'IT Manager',  'اعتماد مدير تقنية المعلومات',   'IT manager approval')
ON CONFLICT (module_type, step_number) DO NOTHING;
