-- MIGRATION_086_subscription_purchase_foundation.sql
-- Stage B7 — Trial-to-Paid Customer Self-Service Subscription Checkout (see
-- claude/chat7a-b7-customer-subscription-checkout-design-pass-v3-2026-09-24.md,
-- approved for implementation, §10). Purely additive on top of MIGRATION_085:
--
--   A. subscriptions.status becomes NOT NULL + CHECK over the five approved
--      values (active, past_due, cancelled, pending_payment, abandoned).
--   B. subscriptions guard trigger: the pending_payment / abandoned lifecycle
--      (pending_payment -> active | abandoned only; abandoned terminal; no row
--      may enter either state by UPDATE except pending_payment -> abandoned)
--      and full immutability of every column except status on those rows.
--      Rows in active / past_due / cancelled keep today's behaviour exactly.
--   C. invoices: 'void' joins 'issued'/'paid' (issued -> void only) plus a
--      status-transition guard trigger (issued -> paid | void only).
--   D. subscription_purchases: the durable, append-only customer purchase
--      intent linking a pending subscription and its issued invoice.
--
-- It issues no UPDATE/DELETE against any existing row — every statement
-- changes constraints, triggers, or creates a new, empty table.
--
-- PREFLIGHT_B7_subscription_purchase_schema_check.js MUST be run against the
-- real target database and its output reviewed BEFORE this file is ever run
-- there — in particular: zero NULL subscriptions.status values, every existing
-- status within {active, past_due, cancelled}, every invoice status within
-- {issued, paid}, no pre-existing user trigger on subscriptions/invoices, and
-- no 086 artifact already present (a partial/prior application must STOP).
--
-- Whole-file transaction, matching MIGRATION_082-085's convention. No rollback
-- SQL is shipped (decision D8): the file is atomic, and after it is applied the
-- kill switch is feature availability (ENABLE_PAYMENT_SIMULATOR /
-- PAYMENT_SIMULATOR_COMPANY_IDS), which stops any new B7 record.
--
-- Run from backend/: node scripts/run-sql.js docs/MIGRATION_086_subscription_purchase_foundation.sql

BEGIN;

-- ============================================================================
-- Part A — subscriptions.status: NOT NULL + CHECK. DEFAULT 'active' is kept.
-- ============================================================================

ALTER TABLE subscriptions ALTER COLUMN status SET NOT NULL;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_valid
  CHECK (status IN ('active', 'past_due', 'cancelled', 'pending_payment', 'abandoned'));

-- ============================================================================
-- Part B — subscriptions guard: pending/abandoned lifecycle + immutability.
-- ============================================================================

CREATE OR REPLACE FUNCTION subscriptions_guard_pending() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'abandoned' THEN
      RAISE EXCEPTION 'subscriptions: rows cannot be created as abandoned';
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE' from here on.

  -- No row may enter pending_payment/abandoned by UPDATE, except
  -- pending_payment -> abandoned.
  IF NEW.status = 'pending_payment' AND OLD.status <> 'pending_payment' THEN
    RAISE EXCEPTION 'subscriptions: cannot transition into pending_payment (id=%)', OLD.id;
  END IF;
  IF NEW.status = 'abandoned' AND OLD.status NOT IN ('pending_payment', 'abandoned') THEN
    RAISE EXCEPTION 'subscriptions: only pending_payment may become abandoned (id=%)', OLD.id;
  END IF;

  IF OLD.status IN ('pending_payment', 'abandoned') THEN
    IF OLD.status = 'abandoned' AND NEW.status <> 'abandoned' THEN
      RAISE EXCEPTION 'subscriptions: abandoned is terminal (id=%)', OLD.id;
    END IF;
    IF OLD.status = 'pending_payment' AND NEW.status NOT IN ('pending_payment', 'active', 'abandoned') THEN
      RAISE EXCEPTION 'subscriptions: pending_payment -> % not permitted (id=%)', NEW.status, OLD.id;
    END IF;
    IF NEW.id                   IS DISTINCT FROM OLD.id
    OR NEW.company_id           IS DISTINCT FROM OLD.company_id
    OR NEW.plan                 IS DISTINCT FROM OLD.plan
    OR NEW.monthly_price        IS DISTINCT FROM OLD.monthly_price
    OR NEW.auto_renew           IS DISTINCT FROM OLD.auto_renew
    OR NEW.next_billing_date    IS DISTINCT FROM OLD.next_billing_date
    OR NEW.created_at           IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at           IS DISTINCT FROM OLD.updated_at
    OR NEW.currency             IS DISTINCT FROM OLD.currency
    OR NEW.billing_interval     IS DISTINCT FROM OLD.billing_interval
    OR NEW.current_period_start IS DISTINCT FROM OLD.current_period_start
    OR NEW.current_period_end   IS DISTINCT FROM OLD.current_period_end
    OR NEW.period_amount        IS DISTINCT FROM OLD.period_amount THEN
      RAISE EXCEPTION 'subscriptions: pending/abandoned rows are immutable except status (id=%)', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER subscriptions_guard_pending_trg
  BEFORE INSERT OR UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION subscriptions_guard_pending();
-- The pending_payment -> active UPDATE can therefore change ONLY status.

-- ============================================================================
-- Part C — invoices: 'void' + status-transition guard.
-- ============================================================================

ALTER TABLE invoices DROP CONSTRAINT invoices_status_valid;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_valid
  CHECK (status IN ('issued', 'paid', 'void'));
-- invoices_payment_date_consistency (MIGRATION_085) is unchanged:
-- ((status = 'paid') = (payment_date IS NOT NULL)), so a void invoice can never
-- carry a payment_date.

CREATE OR REPLACE FUNCTION invoices_guard_status_transition() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'issued' AND NEW.status IN ('paid', 'void')) THEN
    RAISE EXCEPTION 'invoices: status transition % -> % is not permitted (id=%)', OLD.status, NEW.status, OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoices_guard_status_transition_trg
  BEFORE UPDATE ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION invoices_guard_status_transition();

-- ============================================================================
-- Part D — subscription_purchases.
-- ============================================================================

CREATE TABLE subscription_purchases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  subscription_id UUID NOT NULL,
  invoice_id      UUID NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  voided_at       TIMESTAMPTZ,
  CONSTRAINT subscription_purchases_subscription_fk
    FOREIGN KEY (subscription_id, company_id) REFERENCES subscriptions (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_purchases_invoice_fk
    FOREIGN KEY (invoice_id, company_id, subscription_id)
    REFERENCES invoices (id, company_id, subscription_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_purchases_invoice_unique      UNIQUE (invoice_id),
  CONSTRAINT subscription_purchases_subscription_unique UNIQUE (subscription_id),
  CONSTRAINT subscription_purchases_status_valid        CHECK (status IN ('open', 'completed', 'void')),
  CONSTRAINT subscription_purchases_expiry_after_create CHECK (expires_at > created_at),
  CONSTRAINT subscription_purchases_completed_at_consistency CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT subscription_purchases_voided_at_consistency    CHECK ((status = 'void') = (voided_at IS NOT NULL))
);

-- At most one open purchase per company — the concurrency-safe backstop behind
-- the company-row lock every B7 confirm takes first.
CREATE UNIQUE INDEX subscription_purchases_one_open_per_company
  ON subscription_purchases (company_id) WHERE status = 'open';

CREATE OR REPLACE FUNCTION subscription_purchases_guard_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.completed_at IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'subscription_purchases: new rows must start open with completed_at/voided_at unset';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'subscription_purchases: rows are append-only and can never be deleted (id=%)', OLD.id;
  END IF;

  -- TG_OP = 'UPDATE' from here on.

  IF NEW.id              IS DISTINCT FROM OLD.id
  OR NEW.company_id      IS DISTINCT FROM OLD.company_id
  OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
  OR NEW.invoice_id      IS DISTINCT FROM OLD.invoice_id
  OR NEW.created_at      IS DISTINCT FROM OLD.created_at
  OR NEW.expires_at      IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'subscription_purchases: identity/link/time columns are immutable (id=%)', OLD.id;
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'completed' THEN
    -- The trigger is the sole authority for completed_at/voided_at — real
    -- time (clock_timestamp()), not the transaction start (design v3 R1).
    NEW.completed_at := clock_timestamp();
    NEW.voided_at := NULL;
    RETURN NEW;
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'void' THEN
    NEW.voided_at := clock_timestamp();
    NEW.completed_at := NULL;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'subscription_purchases: transition % -> % is not permitted (id=%)', OLD.status, NEW.status, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER subscription_purchases_guard_mutation_trg
  BEFORE INSERT OR UPDATE OR DELETE ON subscription_purchases
  FOR EACH ROW
  EXECUTE FUNCTION subscription_purchases_guard_mutation();

COMMIT;

-- Left deliberately untouched, per the approved design:
--   * companies — no column, constraint, or row is changed by this migration.
--   * payment_attempts, payment_checkout_sessions — unchanged (B5/B6 guards
--     and constraints are reused as-is).
--   * No new queue, worker, scheduler, or email is introduced.
