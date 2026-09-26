-- MIGRATION_087_subscription_upgrade_foundation.sql
-- Stage B8 — Paid-to-Paid Self-Service Subscription Upgrades (see
-- claude/chat8a-b8-paid-subscription-upgrade-design-pass-v4-2026-09-24.md,
-- approved for implementation, §10). Purely additive on top of MIGRATION_086:
--
--   A. subscriptions.status gains 'superseded' (decision O8): the terminal
--      state of a paid subscription replaced by a self-service upgrade.
--   B. subscriptions guard (086) extended: 'superseded' may be entered only
--      from 'active', changing status only; it is terminal and fully
--      immutable; no row may be INSERTed as 'superseded'. Every 086 rule is
--      reproduced verbatim below.
--   C. subscription_purchases.replaces_subscription_id — the one new column:
--      NULL for B7 trial-to-paid purchases, the replaced live subscription for
--      B8 upgrades. Composite FK (same company), not-self CHECK, and a partial
--      unique index making "the same subscription superseded twice"
--      structurally impossible.
--   D. subscription_purchases guard (086) extended: replaces_subscription_id
--      is immutable, and on INSERT it must reference a currently 'active' row.
--      The 086 clock_timestamp() stamps are preserved verbatim.
--   E. payment_attempts guard (085) — body reproduced verbatim except the
--      three terminal stamps now use clock_timestamp() instead of now().
--   F. payment_checkout_sessions guard (085) — body reproduced verbatim except
--      resolved_at now uses clock_timestamp() (and its comment says so).
--
-- E/F exist because now() is the TRANSACTION START time: a settlement that
-- waited on the company/invoice lock would otherwise stamp a time earlier than
-- the moment its locks were actually acquired (design v4 §8.7, review B8-03).
-- Migrations 082-086 are NOT edited; every function change lives here as a
-- full CREATE OR REPLACE (existing trigger bindings are reused unchanged).
--
-- Deliberately NOT included: any invoice column guard (invoice snapshot
-- immutability stays application-enforced — design v4 §10.1), any interval
-- column (same-interval-only, O4, is enforced in application code), and any
-- UPDATE/DELETE of an existing row.
--
-- Invariant for the 'superseded' status-only comparison below: the
-- subscriptions table has exactly 14 columns (id, company_id, plan, status,
-- monthly_price, auto_renew, next_billing_date, created_at, updated_at,
-- currency, billing_interval, current_period_start, current_period_end,
-- period_amount). A future column MUST be added to both guard lists.
--
-- PREFLIGHT_B8_subscription_upgrade_schema_check.js MUST be run against the
-- real target database, and its output reviewed, BEFORE this file is run
-- there. Deploy order: preflight -> this migration -> re-run preflight
-- (expect STOP) -> backend -> frontend. Never deploy B8 backend code on a
-- database without this migration.
--
-- Whole-file transaction (082-086 convention). No rollback SQL: the file is
-- atomic and forward-compatible with B7 code; the kill switch is the payment
-- simulator allowlist / ENABLE_PAYMENT_SIMULATOR.
--
-- Run from backend/: node scripts/run-sql.js docs/MIGRATION_087_subscription_upgrade_foundation.sql

BEGIN;

-- ============================================================================
-- Part A — subscriptions.status += 'superseded'.
-- ============================================================================

ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_valid;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_valid
  CHECK (status IN ('active', 'past_due', 'cancelled', 'pending_payment', 'abandoned', 'superseded'));

-- ============================================================================
-- Part B — subscriptions guard: 086 rules verbatim + the superseded rules.
-- ============================================================================

CREATE OR REPLACE FUNCTION subscriptions_guard_pending() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'abandoned' THEN
      RAISE EXCEPTION 'subscriptions: rows cannot be created as abandoned';
    END IF;
    -- B8: nor as superseded.
    IF NEW.status = 'superseded' THEN
      RAISE EXCEPTION 'subscriptions: rows cannot be created as superseded';
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE' from here on.

  -- B8: superseded is terminal and fully immutable.
  IF OLD.status = 'superseded' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
    OR NEW.id                   IS DISTINCT FROM OLD.id
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
      RAISE EXCEPTION 'subscriptions: superseded rows are terminal and immutable (id=%)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  -- B8: only active -> superseded, changing status only.
  IF NEW.status = 'superseded' THEN
    IF OLD.status <> 'active' THEN
      RAISE EXCEPTION 'subscriptions: only active may become superseded (id=%)', OLD.id;
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
      RAISE EXCEPTION 'subscriptions: active -> superseded may change status only (id=%)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  -- ---- MIGRATION_086 rules, verbatim ----

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
-- subscriptions_guard_pending_trg (MIGRATION_086) is reused unchanged.

-- ============================================================================
-- Part C — subscription_purchases.replaces_subscription_id.
-- ============================================================================

ALTER TABLE subscription_purchases
  ADD COLUMN replaces_subscription_id UUID,
  ADD CONSTRAINT subscription_purchases_replaces_fk
    FOREIGN KEY (replaces_subscription_id, company_id)
    REFERENCES subscriptions (id, company_id) ON DELETE RESTRICT,
  ADD CONSTRAINT subscription_purchases_replaces_not_self
    CHECK (replaces_subscription_id IS NULL OR replaces_subscription_id <> subscription_id);

-- A replaced subscription can be the source of at most ONE completed upgrade.
CREATE UNIQUE INDEX subscription_purchases_one_completed_per_replaced
  ON subscription_purchases (replaces_subscription_id)
  WHERE status = 'completed' AND replaces_subscription_id IS NOT NULL;

-- ============================================================================
-- Part D — subscription_purchases guard: 086 body verbatim + replaces rules.
-- ============================================================================

CREATE OR REPLACE FUNCTION subscription_purchases_guard_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.completed_at IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'subscription_purchases: new rows must start open with completed_at/voided_at unset';
    END IF;
    -- B8: an upgrade purchase must replace a currently active subscription
    -- (the composite FK already guarantees the same company).
    IF NEW.replaces_subscription_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM subscriptions
                       WHERE id = NEW.replaces_subscription_id AND status = 'active') THEN
      RAISE EXCEPTION 'subscription_purchases: replaces_subscription_id must reference an active subscription';
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
  OR NEW.expires_at      IS DISTINCT FROM OLD.expires_at
  OR NEW.replaces_subscription_id IS DISTINCT FROM OLD.replaces_subscription_id THEN
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
-- subscription_purchases_guard_mutation_trg (MIGRATION_086) is reused unchanged.

-- ============================================================================
-- Part E — payment_attempts guard: MIGRATION_085 Part E body verbatim, except
-- failed_at / succeeded_at / cancelled_at := clock_timestamp().
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
    NEW.failed_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF OLD.status = 'initiated' AND NEW.status = 'succeeded' THEN
    NEW.succeeded_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF OLD.status = 'initiated' AND NEW.status = 'cancelled' THEN
    NEW.cancelled_at := clock_timestamp();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'payment_attempts: transition % -> % is not permitted (id=%)', OLD.status, NEW.status, OLD.id;
END;
$$ LANGUAGE plpgsql;
-- payment_attempts_guard_mutation_trg (MIGRATION_084) is reused unchanged.

-- ============================================================================
-- Part F — payment_checkout_sessions guard: MIGRATION_085 Part D body
-- verbatim, except resolved_at := clock_timestamp() (and its comment).
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
    -- this unconditionally overwrites it with the real statement clock
    -- (clock_timestamp(), MIGRATION_087), taken after the caller's locks.
    NEW.resolved_at := clock_timestamp();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'payment_checkout_sessions: transition % -> % is not permitted (id=%)', OLD.status, NEW.status, OLD.id;
END;
$$ LANGUAGE plpgsql;
-- payment_checkout_sessions_guard_mutation_trg (MIGRATION_085) is reused unchanged.

COMMIT;

-- Left deliberately untouched: companies, invoices (no new column guard),
-- every existing row, migrations 082-086. No queue, worker, scheduler or
-- email is introduced.
