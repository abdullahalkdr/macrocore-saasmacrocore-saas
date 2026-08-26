-- MIGRATION_072_request_type_approval_config.sql
--
-- Per-request-type Approval Workflow configuration — replaces MIGRATION_056's
-- one-size-fits-all "every ITSM ticket gets the same 3-step chain" with what
-- large-company ITSM tools (ServiceNow, Jira Service Management, Freshservice)
-- actually do: approval is a property of the SPECIFIC request type, not the
-- whole ticketing module.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_072_request_type_approval_config.sql
--
-- Design decisions:
--   1. service_request_types.requires_approval — off by default for every
--      existing and new request type. Nothing is gated behind approval until
--      an admin explicitly turns it on for that specific request type and
--      configures at least one step (enforced in the controller, not the DB —
--      see setApprovalSteps()). Incident/fault-report types are meant to stay
--      off permanently (no decision to approve — see the handoff doc's
--      reasoning); Service Request types (new hardware, access, licenses) are
--      the intended candidates.
--   2. request_type_approval_steps replaces approval_workflow_steps for all
--      NEW chains. Only two approver_type strategies survive here:
--      'department_manager' (the ticket requester's own department manager —
--      unchanged resolution logic) and 'job_role' (now a real FK to
--      job_roles.id, not a name string match — cleaner than MIGRATION_056's
--      approver_value text match, and immune to a role being renamed later).
--      'ticket_assignee' is deliberately NOT offered here: per this
--      migration's own design review, "the assigned agent acts on the
--      ticket" isn't an approval decision, it's fulfillment — that's now
--      just normal ticket status (assigned -> in progress -> resolved), not
--      a step in this chain.
--   3. approval_workflow_steps (MIGRATION_056) is NOT dropped or altered —
--      backend/src/utils/itsmApprovals.ts keeps reading it as a fallback ONLY
--      for approval_requests rows that were already spawned before this
--      migration (so an in-flight chain like an existing pending ticket
--      keeps working exactly as before, instead of breaking mid-flight). No
--      new chain is ever spawned from the old table after this migration.
--   4. ON DELETE CASCADE on request_type_approval_steps.request_type_id —
--      deleting a request type deletes its step configuration with it, same
--      as service_custom_fields already does for the same parent.
--   5. approver_job_role_id ON DELETE SET NULL, not CASCADE — deleting a job
--      role should not silently delete an admin's approval configuration;
--      it leaves the step "unstaffed" (resolveItsmStepEligibility's existing
--      allowAnyManager fallback already handles that gracefully), which is a
--      visible, fixable state rather than the step vanishing outright.
--
-- Run again after any migration: safe, IF NOT EXISTS / idempotent throughout.

ALTER TABLE service_request_types ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS request_type_approval_steps (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_type_id       UUID NOT NULL REFERENCES service_request_types(id) ON DELETE CASCADE,
  step_number           INT NOT NULL,
  approver_type         VARCHAR(30) NOT NULL CHECK (approver_type IN ('department_manager', 'job_role')),
  approver_job_role_id  UUID REFERENCES job_roles(id) ON DELETE SET NULL,
  step_label            VARCHAR(120) NOT NULL,
  step_label_en         VARCHAR(120),
  UNIQUE (request_type_id, step_number)
);

CREATE INDEX IF NOT EXISTS idx_request_type_approval_steps_type ON request_type_approval_steps (request_type_id);
