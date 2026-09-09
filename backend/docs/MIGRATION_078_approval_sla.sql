-- MIGRATION_078_approval_sla.sql
--
-- Phase 4 (Chat 2) — Financial Approval SLA tracking. Adds the minimum state
-- needed to run a 24h flat SLA window, a 75%-elapsed reminder, and a breach
-- notice for the three single-step financial approval modules
-- (PAYROLL/PURCHASE_ORDER/EXPENSE) — see claude/phase4-sla-scope-decision.md
-- (project doc) for the confirmed scope and why this is minimal.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_078_approval_sla.sql
--
-- Design decisions:
--   1. All three columns nullable, no default beyond NULL. ITSM_TICKET rows
--      never get sla_deadline_at stamped (utils/financialApprovals.ts's
--      fileApprovalRequest() only sets it for module types with a
--      MODULE_LABEL entry) — this migration does not touch ITSM_TICKET's
--      multi-step chain or support_tickets' own separate SLA columns
--      (MIGRATION_043) in any way.
--   2. No escalation_level / escalated_at column. The confirmed design (see
--      the project doc) found no distinct company-owner or escalation-tier
--      concept anywhere in the live schema or code (roles are just
--      admin/manager/employee/viewer on users.role, no owner_id anywhere) —
--      every admin/manager is already part of the eligible-approver
--      audience that gets the reminder AND the breach email, so a separate
--      "escalate to admin" step would just be a duplicate send, not a real
--      escalation tier. If a real distinct escalation contact is added to
--      the product later, that's a new migration, not a retrofit here.
--   3. No new "SLA cycle" counter column either. Resubmitting a returned
--      request sets a fresh sla_deadline_at (utils/financialApprovals.ts's
--      notifyEligibleApprovers()/approvals.controller.ts's resubmitted
--      branch) and clears the two tracking columns below — the new
--      sla_deadline_at value itself is what every email's dedup_key uses to
--      distinguish one SLA cycle from the next, so no extra column is
--      needed just to tell cycles apart.
--   4. sla_reminder_sent_at / sla_breached_at are set ONLY when an email
--      actually reached at least one real eligible approver (see
--      utils/approvalSla.ts's sweepApprovalSla()) — if nobody could be
--      resolved as an approver, both stay NULL so the next sweep tick keeps
--      retrying (in case eligibility changes, e.g. someone is later made a
--      manager). The one-time "this needs admin attention" notice sent to
--      the requester in that case is deduped at the email_jobs layer
--      instead (dedup_key), not gated by these columns.
--
-- Run again after any migration: safe, idempotent (IF NOT EXISTS).

ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS sla_deadline_at TIMESTAMP;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS sla_reminder_sent_at TIMESTAMP;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMP;

-- Covers sweepApprovalSla()'s own candidate-selection query directly (status
-- + module_type + "still has unresolved SLA work" filter).
CREATE INDEX IF NOT EXISTS idx_approval_requests_sla_pending
  ON approval_requests (module_type, status, sla_deadline_at)
  WHERE sla_deadline_at IS NOT NULL;
