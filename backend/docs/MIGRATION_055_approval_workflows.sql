-- MIGRATION_055_approval_workflows.sql
--
-- Core Enterprise Approval Workflow Engine (Maker-Checker pattern) — foundational
-- schema + audit trail for sensitive requests (payroll runs, purchase orders,
-- expenses, ...) that need a formal approval before they take effect.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_055_approval_workflows.sql
--
-- Design decisions:
--   1. `reference_id` is a plain UUID with no FK — it points at a row in whichever
--      table `module_type` names (payroll, purchase_orders, expenses, ...), and those
--      target tables vary in shape. A polymorphic reference can't carry a real FK
--      constraint in Postgres without either a trigger-based check or one nullable FK
--      column per module (both heavier than this foundational step needs) — resolving
--      reference_id -> the actual row is left to the caller, same pattern
--      audit_log.entity_id already uses elsewhere in this codebase.
--   2. `requester_id`/`approver_id` reference `employees(id)`, not `users(id)` — mirrors
--      job_role_permissions/payroll's own "the org chart is expressed in employees,
--      logins are just how a employee authenticates" convention. A user with no linked
--      employee record (a pure admin/owner login) cannot file or act on an approval
--      request; the controller enforces that explicitly rather than relying on the FK.
--   3. `current_step`/multi-tier chains: the column exists so a later migration can add
--      a chain-of-approvers config table without another ALTER TABLE, but THIS
--      migration does not ship that config table. Until it exists, every approval
--      request is effectively single-step — approvals.controller.ts documents this
--      explicitly. Do not treat `current_step > 1` as reachable yet.
--   4. CHECK constraints on status/action, same defense-in-depth style as this
--      codebase's other enum-ish VARCHAR columns being validated in the controller
--      AND at the DB layer (belt and suspenders — a direct SQL fix-up script can't
--      silently write an invalid status).
--
-- Run again after any migration: safe, IF NOT EXISTS / idempotent throughout.

-- ========================================================================
-- 1. approval_requests
-- ========================================================================

CREATE TABLE IF NOT EXISTS approval_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module_type   VARCHAR(50) NOT NULL,
  reference_id  UUID NOT NULL,
  requester_id  UUID NOT NULL REFERENCES employees(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  current_step  INT NOT NULL DEFAULT 1,
  created_at    TIMESTAMP DEFAULT now(),
  updated_at    TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_company ON approval_requests (company_id);
-- Covers listPending()'s "pending requests for this company" query directly.
CREATE INDEX IF NOT EXISTS idx_approval_requests_company_status ON approval_requests (company_id, status);
-- Covers "does an approval request already exist for this record" lookups a future
-- integration (e.g. payroll.controller.ts's pay()) will need before creating a new one.
CREATE INDEX IF NOT EXISTS idx_approval_requests_module_ref ON approval_requests (module_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_requester ON approval_requests (requester_id);

-- ========================================================================
-- 2. approval_steps_log — append-only audit trail, one row per action taken
--    (approve/reject/delegate) on a request, at whichever step it happened.
-- ========================================================================

CREATE TABLE IF NOT EXISTS approval_steps_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id  UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  step_number          INT NOT NULL,
  approver_id          UUID REFERENCES employees(id),
  action                VARCHAR(20) NOT NULL
                          CHECK (action IN ('approved', 'rejected', 'delegated')),
  comments              TEXT,
  action_at             TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approval_steps_log_request ON approval_steps_log (approval_request_id);
