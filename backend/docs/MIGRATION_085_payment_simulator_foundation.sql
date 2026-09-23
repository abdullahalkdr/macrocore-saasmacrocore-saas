-- MIGRATION_085_payment_simulator_foundation.sql
-- Stage B6 — Provider-Neutral Simulated Payment Flow (see
-- claude/chat6a-b6-payment-simulator-design-pass-v5-2026-09-17.md, approved
-- for implementation with the release-owner's 8 numbered implementation
-- clarifications from the approval message). This migration is purely
-- additive on top of B5's own MIGRATION_084 — it widens payment_attempts'
-- terminal-state CHECK/trigger, converts invoices.payment_date to
-- TIMESTAMPTZ and widens invoices_status_valid, and adds a brand-new
-- payment_checkout_sessions table. It issues no UPDATE/DELETE against any
-- existing row — every ALTER here changes constraints/column types only.
--
-- PREFLIGHT_B6_payment_simulator_schema_check.js (this stage's own new
-- script, mirroring PREFLIGHT_B5_payment_attempts_schema_check.js's
-- structure) MUST be run against the real target database and its output
-- reviewed BEFORE this file is ever run there — in particular its
-- payment_date-is-all-NULL check, which is exactly what the pure type
-- widening below depends on being true, and its confirmation that none of
-- this migration's target artifacts already exist (a partial/prior
-- application must STOP, never proceed).
--
-- Whole-file transaction, matching MIGRATION_084's own convention.
--
-- Run from backend/: node scripts/run-sql.js docs/MIGRATION_085_payment_simulator_foundation.sql

BEGIN;

-- ============================================================================
-- Part A — payment_attempts: three-way terminal state (design doc §5.1/v3
-- §5.1). 'succeeded' and 'cancelled' join the existing 'failed' as terminal
-- outcomes reachable only from 'initiated', each trigger-stamped, each
-- mutually exclusive with the others by construction (the CHECK below is a
-- flat enum, and the guard trigger — Part D — only ever accepts one
-- transition per row, ever).
-- ============================================================================

ALTER TABLE payment_attempts ADD COLUMN succeeded_at TIMESTAMPTZ;
ALTER TABLE payment_attempts ADD COLUMN cancelled_at TIMESTAMPTZ;

ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_status_valid;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_valid
  CHECK (status IN ('initiated', 'failed', 'succeeded', 'cancelled'));

ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_succeeded_at_consistency
  CHECK ((status = 'succeeded') = (succeeded_at IS NOT NULL));
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_cancelled_at_consistency
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));
-- payment_attempts_failed_at_consistency already exists from MIGRATION_084 —
-- untouched, still enforces the same tie for the pre-existing 'failed' state.

-- ============================================================================
-- Part B — invoices: payment_date widened to TIMESTAMPTZ (pure type widening
-- — PREFLIGHT_B6 confirms the column is 100% NULL today, so no USING clause
-- or data-loss risk exists), invoices_status_valid widened to allow 'paid',
-- and a database-enforced tie between the two so "paid without a
-- payment_date" or "payment_date set while still issued" are both
-- structurally impossible, not merely application-checked.
-- ============================================================================

ALTER TABLE invoices ALTER COLUMN payment_date TYPE TIMESTAMPTZ;

ALTER TABLE invoices DROP CONSTRAINT invoices_status_valid;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_valid
  CHECK (status IN ('issued', 'paid'));

ALTER TABLE invoices ADD CONSTRAINT invoices_payment_date_consistency
  CHECK ((status = 'paid') = (payment_date IS NOT NULL));

-- ============================================================================
-- Part C — payment_checkout_sessions. A strict 1:1 child of payment_attempts
-- (UNIQUE alone backs the FK, no separate index needed). No page_token, no
-- checkout_url column — nothing about the hosted-page credential is ever
-- persisted; it's deterministically re-derived from `id` +
-- PAYMENT_SIMULATOR_TOKEN_SECRET on every read/verify (see
-- utils/paymentSimulatorToken.ts). provider is narrow ('simulated' only)
-- today, on purpose — widened only when a real provider is actually
-- implemented, never preemptively.
-- ============================================================================

CREATE TABLE payment_checkout_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  payment_attempt_id UUID NOT NULL UNIQUE
    REFERENCES payment_attempts (id) ON DELETE RESTRICT,

  provider VARCHAR(20) NOT NULL DEFAULT 'simulated'
    CHECK (provider = 'simulated'),

  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,

  CONSTRAINT payment_checkout_sessions_resolved_at_consistency
    CHECK ((status != 'pending') = (resolved_at IS NOT NULL))
);

-- ============================================================================
-- Part D — trigger-enforced initial state, immutability, and append-only-ness
-- on payment_checkout_sessions. BEFORE INSERT OR UPDATE OR DELETE, mirroring
-- payment_attempts_guard_mutation_trg's own structure exactly.
-- ============================================================================

CREATE OR REPLACE FUNCTION payment_checkout_sessions_guard_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.resolved_at IS NOT NULL THEN
      RAISE EXCEPTION
        'payment_checkout_sessions: new rows must start as pending with resolved_at unset';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'payment_checkout_sessions: rows are append-only and can never be deleted (id=%)', OLD.id;
  END IF;

  -- TG_OP = 'UPDATE' from here on.

  IF NEW.id                 IS DISTINCT FROM OLD.id
     OR NEW.payment_attempt_id IS DISTINCT FROM OLD.payment_attempt_id
     OR NEW.provider           IS DISTINCT FROM OLD.provider
     OR NEW.created_at         IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'payment_checkout_sessions: id/payment_attempt_id/provider/created_at columns are immutable (id=%)', OLD.id;
  END IF;

  IF OLD.status = 'pending' AND NEW.status IN ('succeeded', 'failed', 'cancelled') THEN
    -- The trigger is the sole authority for resolved_at. Whatever the
    -- calling statement's SET clause did or didn't include is irrelevant —
    -- this unconditionally overwrites it with PostgreSQL transaction time.
    NEW.resolved_at := now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'payment_checkout_sessions: transition % -> % is not permitted (id=%)', OLD.status, NEW.status, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_checkout_sessions_guard_mutation_trg
  BEFORE INSERT OR UPDATE OR DELETE ON payment_checkout_sessions
  FOR EACH ROW
  EXECUTE FUNCTION payment_checkout_sessions_guard_mutation();

-- ============================================================================
-- Part E — extend payment_attempts_guard_mutation() (MIGRATION_084) with the
-- two new permitted transitions, both from 'initiated': -> 'succeeded'
-- (stamps succeeded_at) and -> 'cancelled' (stamps cancelled_at), mirroring
-- -> 'failed'/failed_at verbatim. Every other clause of the function
-- (INSERT must start 'initiated' with failed_at unset, DELETE always
-- rejected, the full immutable-column list) is reproduced byte-for-byte
-- unchanged from MIGRATION_084 — this is a full CREATE OR REPLACE, not a
-- diff, so the function's complete, current body is visible in one place.
-- ============================================================================

CREATE OR REPLACE FUNCTION payment_attempts_guard_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'initiated' OR NEW.failed_at IS NOT NULL THEN
      RAISE EXCEPTION
        'payment_attempts: new rows must start as initiated with failed_at unset';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'payment_attempts: rows are append-only and can never be deleted (id=%)', OLD.id;
  END IF;

  -- TG_OP = 'UPDATE' from here on.

  IF NEW.id                IS DISTINCT FROM OLD.id
     OR NEW.invoice_id       IS DISTINCT FROM OLD.invoice_id
     OR NEW.company_id      IS DISTINCT FROM OLD.company_id
     OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
     OR NEW.amount           IS DISTINCT FROM OLD.amount
     OR NEW.currency         IS DISTINCT FROM OLD.currency
     OR NEW.plan             IS DISTINCT FROM OLD.plan
     OR NEW.billing_interval IS DISTINCT FROM OLD.billing_interval
     OR NEW.period_start     IS DISTINCT FROM OLD.period_start
     OR NEW.period_end       IS DISTINCT FROM OLD.period_end
     OR NEW.idempotency_key  IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at       IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'payment_attempts: id/identity/snapshot/idempotency/created_at columns are immutable (id=%)', OLD.id;
  END IF;

  IF OLD.status = 'initiated' AND NEW.status = 'failed' THEN
    NEW.failed_at := now();
    RETURN NEW;
  END IF;

  IF OLD.status = 'initiated' AND NEW.status = 'succeeded' THEN
    NEW.succeeded_at := now();
    RETURN NEW;
  END IF;

  IF OLD.status = 'initiated' AND NEW.status = 'cancelled' THEN
    NEW.cancelled_at := now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'payment_attempts: transition % -> % is not permitted (id=%)', OLD.status, NEW.status, OLD.id;
END;
$$ LANGUAGE plpgsql;

-- The trigger itself (payment_attempts_guard_mutation_trg) already exists
-- from MIGRATION_084 and needs no change — CREATE OR REPLACE FUNCTION above
-- is enough; Postgres re-resolves the trigger to the replaced function body
-- automatically, no CREATE OR REPLACE TRIGGER or DROP/CREATE needed.

COMMIT;

-- Left deliberately untouched, per the approved design:
--   * subscriptions, companies — no column, constraint, or row is read,
--     written, or otherwise touched by this migration.
--   * invoices.telr_transaction_id, invoices.pdf_url — untouched.
--   * No new queue, worker, scheduler, or email is introduced. No frontend
--     change accompanies this migration.
