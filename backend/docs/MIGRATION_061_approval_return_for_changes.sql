-- MIGRATION_061_approval_return_for_changes.sql
--
-- Adds a third decision to the Approval Engine besides approve/reject: "Return for
-- Changes" (Maker-Checker's standard "send back to submitter" pattern, same as
-- SAP/Oracle-style workflows) -- an approver can kick a request back one step
-- instead of only approving or rejecting outright, the maker fixes/attaches what
-- was asked for, then resubmits and the chain picks up right where it left off.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_061_approval_return_for_changes.sql
--
-- Design decisions (per Abdullah's own answers on how this should route):
--   1. "Return" always goes back exactly ONE step, never straight to the original
--      maker regardless of where you are in the chain. For ITSM_TICKET's 3-step
--      chain (department manager -> IT agent -> IT manager): step 3 returns to
--      step 2's actor, step 2 returns to step 1's actor. Only step 1 has no step
--      before it -- returning FROM step 1 goes to the maker themselves, since
--      there's no earlier approver to bounce it to. Single-step financial modules
--      (PAYROLL/PURCHASE_ORDER/EXPENSE) only ever have one step, so returning from
--      it always means "back to the maker" too.
--   2. Modeled as current_step arithmetic, reusing the SAME eligibility machinery
--      that already resolves "who acts at step N" -- no new eligibility concept:
--        - Returning from step N (N >= 2): current_step -> N-1, status stays
--          'pending'. The step N-1 actor now sees it as a normal pending item in
--          their queue (resolveItsmStepEligibility already handles this) --
--          approving it there simply re-advances current_step back to N as usual.
--        - Returning from step 1 (or a single-step module's only step):
--          current_step -> 0, status -> 'returned'. current_step = 0 has no
--          matching approval_workflow_steps row by construction -- it specifically
--          means "with the maker, not any approval step", so it can never appear
--          in anyone's pending-approvals queue (listPending only ever selects
--          status = 'pending').
--   3. Resubmitting (maker-only, requires status = 'returned') sets current_step
--      back to 1 and status back to 'pending' -- resumes at the exact step that
--      requested the change, never a full restart of an already-approved chain.
--   4. New approval_steps_log.action values: 'returned' (logged by the approver
--      who sent it back, with a MANDATORY comment -- the whole point is telling the
--      maker what to fix) and 'resubmitted' (logged by the maker). Existing CHECK
--      constraints on both approval_requests.status and approval_steps_log.action
--      are widened via a DO block that finds the constraint by its definition
--      rather than assuming its auto-generated name, so this is safe to re-run
--      even if Postgres named it differently than expected.
--
-- Run again after any migration: safe, idempotent throughout.

DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'approval_requests'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%IN%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE approval_requests DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'returned'));

DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'approval_steps_log'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%action%IN%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE approval_steps_log DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE approval_steps_log
  ADD CONSTRAINT approval_steps_log_action_check
  CHECK (action IN ('approved', 'rejected', 'delegated', 'returned', 'resubmitted'));
