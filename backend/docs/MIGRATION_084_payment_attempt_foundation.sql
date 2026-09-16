-- MIGRATION_084_payment_attempt_foundation.sql
-- Stage B5 — Provider-Neutral Payment Attempt Engine (see
-- claude/chat5a-b5-payment-attempt-engine-design-pass-v4-2026-09-16.md,
-- approved for implementation with the release-owner's numbered
-- clarifications from the approval message — every one of them is reflected
-- below).
--
-- Whole-file transaction (release-owner clarification/Correction 1): unlike
-- treating Part A/B/C as a loose sequence, this file opens with BEGIN and
-- closes with COMMIT around every statement — the two subscriptions/invoices
-- constraint changes, dropping the old FK, CREATE TABLE payment_attempts,
-- both indexes, the function, and the trigger — exactly matching
-- MIGRATION_082/083's own convention. All of this is ordinary transactional
-- DDL (no CONCURRENTLY index build — payment_attempts is brand new and
-- empty, so no concurrent-build concern applies). A failure at any point
-- rolls the entire file back and leaves the schema exactly as it was before
-- this migration ran, with nothing partially applied.
--
-- A production preflight was NOT run against production by this session —
-- no database credentials to a production instance are held here.
-- PREFLIGHT_B5_payment_attempts_schema_check.js (this stage's own new
-- script, mirroring PREFLIGHT_B3's structure) MUST be run against the real
-- target database and its output reviewed BEFORE this file is ever run
-- there — in particular its invoices/subscriptions company_id mismatch
-- check, which is exactly what Part A's new composite foreign key depends on
-- being clean. This session did execute this exact migration successfully
-- against a disposable PostgreSQL database (built by replaying every prior
-- migration in order, 002-083, into a throwaway instance) and separately ran
-- the B5 concurrency smoke checks there — see the implementation report for
-- the exact commands and output. Production still requires a fresh
-- preflight review before this file is run there.
--
-- Run from backend/: node scripts/run-sql.js docs/MIGRATION_084_payment_attempt_foundation.sql

BEGIN;

-- ============================================================================
-- Part A — corrective, DB-enforced tenant consistency between invoices and
-- subscriptions. Must be preceded, in the real migration process, by the
-- PREFLIGHT_B5 mismatch check (docs/PREFLIGHT_B5_payment_attempts_schema_check.js)
-- — not run here, run separately against the real target first.
--
-- Two independent FKs (invoices -> companies, invoices -> subscriptions)
-- never proved that an invoice's own company_id actually matches the
-- company_id of the subscription it points to — a single mismatched row
-- would have been structurally possible. Widening the FK to a composite
-- (subscription_id, company_id) -> subscriptions(id, company_id) makes that
-- mismatch impossible at the database level, not merely application-checked
-- — and payment_attempts (Part B) is then built on the same technique one
-- level further, so a payment attempt's invoice_id/company_id/subscription_id
-- triple is provably consistent with the invoice it claims to belong to.
-- ============================================================================

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_id_company_id_unique UNIQUE (id, company_id);

-- Exact current constraint name confirmed live by PREFLIGHT_B5 before this
-- line runs against any real target (mirrors MIGRATION_083's own stated
-- practice for invoices_company_id_fkey) — taken here from MIGRATION_083's
-- own trailing comment, which names it explicitly, and independently
-- reconfirmed against this session's own disposable database (see the
-- implementation report).
ALTER TABLE invoices DROP CONSTRAINT invoices_subscription_id_fkey;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_subscription_company_fk
  FOREIGN KEY (subscription_id, company_id)
  REFERENCES subscriptions (id, company_id)
  ON DELETE RESTRICT;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_id_company_subscription_unique
  UNIQUE (id, company_id, subscription_id);

-- ============================================================================
-- Part B — payment_attempts itself. A provider-neutral, administrative record
-- of an attempt to collect on an already-`issued` Macrocore subscription
-- invoice. Creating a row is never proof of payment and never activates or
-- changes any subscription/invoice/company row — this stage issues zero
-- UPDATE/DELETE against invoices, subscriptions, or companies. No provider
-- name, provider reference/transaction id, raw provider payload, card data,
-- or CVV column exists anywhere on this table, and none is planned — see the
-- design doc for the full list of what this stage deliberately does not
-- implement (no real provider integration, no webhook, no email, no queue/
-- worker/scheduler).
-- ============================================================================

CREATE TABLE payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  invoice_id      UUID NOT NULL,
  company_id      UUID NOT NULL,
  subscription_id UUID NOT NULL,

  -- Immutable commercial snapshot, copied verbatim (INSERT ... SELECT, never
  -- JS arithmetic) from the invoice at attempt-creation time — see
  -- admin.controller.ts::createPaymentAttempt. A later change to the invoice
  -- (there is currently no code path that changes one) could never
  -- retroactively alter an already-created attempt even if one existed.
  amount           DECIMAL(10, 3) NOT NULL,
  currency         VARCHAR(3)     NOT NULL,
  plan             VARCHAR(20)    NOT NULL,
  billing_interval VARCHAR(10)    NOT NULL,
  period_start     TIMESTAMPTZ    NOT NULL,
  period_end       TIMESTAMPTZ    NOT NULL,

  -- Caller-supplied idempotency key (trimmed and length-validated by the
  -- controller before the INSERT is ever attempted) — globally unique, not
  -- scoped to invoice_id, so the exact same key can never be silently
  -- reused for a different invoice (locked decision, see design doc §2).
  idempotency_key VARCHAR(100) NOT NULL,

  -- Two real states: 'initiated' (the attempt was created; outcome is still
  -- unknown) and 'failed' (an administrator recorded that this specific
  -- attempt did not result in collection — an internal/administrative
  -- closure only, never a provider-shaped status like "declined" or
  -- "timed out", and never a statement about the invoice or subscription
  -- itself). There is deliberately no 'succeeded'/'paid' state in this
  -- stage — creating an attempt or failing it must never be read as
  -- evidence of payment either way; a future stage that adds real payment
  -- confirmation designs that transition separately, on top of this
  -- foundation, not by widening this CHECK casually.
  status VARCHAR(20) NOT NULL DEFAULT 'initiated',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Populated ONLY by the trigger below, exclusively during the one approved
  -- transition — the controller's own UPDATE never sets this column, and
  -- there is no application code path that can set it directly (release-
  -- owner clarification: this is PostgreSQL transaction time, not
  -- claimed anywhere as "the exact instant the administrator clicked
  -- something" — see the mark-failed logic in admin.controller.ts).
  failed_at  TIMESTAMPTZ,

  -- The tenant-consistency technique from Part A, one level further: proves
  -- that THIS row's invoice_id/company_id/subscription_id triple exactly
  -- matches a real invoice's own (id, company_id, subscription_id) — which,
  -- by Part A's own composite FK, is itself already proven consistent with
  -- that invoice's subscription. A payment attempt naming a real invoice_id
  -- but a mismatched company_id or subscription_id is structurally
  -- impossible, not merely application-checked. ON DELETE RESTRICT — an
  -- invoice with at least one payment attempt can never be deleted (there is
  -- no code path that deletes an invoice today; this is the same defensive
  -- posture MIGRATION_083 already took for invoices_company_id_fkey).
  CONSTRAINT payment_attempts_invoice_company_subscription_fk
    FOREIGN KEY (invoice_id, company_id, subscription_id)
    REFERENCES invoices (id, company_id, subscription_id)
    ON DELETE RESTRICT,

  CONSTRAINT payment_attempts_amount_positive
    CHECK (amount > 0),
  CONSTRAINT payment_attempts_currency_supported
    CHECK (currency IN ('USD', 'KWD')),
  CONSTRAINT payment_attempts_billing_interval_valid
    CHECK (billing_interval IN ('monthly', 'annual')),
  CONSTRAINT payment_attempts_period_end_after_start
    CHECK (period_end > period_start),
  CONSTRAINT payment_attempts_status_valid
    CHECK (status IN ('initiated', 'failed')),
  CONSTRAINT payment_attempts_failed_at_consistency
    CHECK ((status = 'failed') = (failed_at IS NOT NULL)),

  -- Normalization-enforcing (release-owner clarification/Correction 3) — the
  -- stored value must already be its own trimmed form, 1-100 characters. The
  -- controller trims and validates before ever reaching SQL; this is the
  -- independent database-level backstop for any insert path that doesn't go
  -- through that controller code.
  CONSTRAINT payment_attempts_idempotency_key_normalized
    CHECK (
      idempotency_key = btrim(idempotency_key)
      AND char_length(idempotency_key) BETWEEN 1 AND 100
    ),

  CONSTRAINT payment_attempts_idempotency_key_unique
    UNIQUE (idempotency_key)
);

-- At most one 'initiated' attempt per invoice at any time — the real,
-- concurrency-safe guard (never an application-level precheck alone, which
-- would itself race). A second concurrent create attempt for the same
-- invoice while one is still 'initiated' fails this partial unique index;
-- admin.controller.ts::createPaymentAttempt's fixed-order recovery logic
-- (never branching on which constraint name Postgres happens to report
-- first) turns that into the documented 409.
CREATE UNIQUE INDEX payment_attempts_one_active_per_invoice
  ON payment_attempts (invoice_id)
  WHERE status = 'initiated';

-- Supports listPaymentAttempts' ORDER BY created_at DESC WHERE invoice_id = $1.
CREATE INDEX payment_attempts_invoice_id_idx
  ON payment_attempts (invoice_id);

-- ============================================================================
-- Part C — trigger-enforced initial state, immutability, and append-only-ness.
-- Every new row must start as 'initiated' with failed_at unset; no direct
-- INSERT may bypass the lifecycle by creating a terminal row. Every column is immutable
-- except `status` (and the trigger-owned `failed_at`), and the only
-- permitted transition is 'initiated' -> 'failed'. Rows can never be
-- deleted, by anyone, for any reason, once created — this is a durable
-- administrative record, not a queue or a cache.
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
    -- The trigger is the sole authority for failed_at. Whatever the calling
    -- statement's SET clause did or didn't include is irrelevant — this
    -- unconditionally overwrites it with PostgreSQL transaction time; it is
    -- not claimed to be the exact commit instant or click time.
    NEW.failed_at := now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'payment_attempts: transition % -> % is not permitted (id=%)', OLD.status, NEW.status, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_attempts_guard_mutation_trg
  BEFORE INSERT OR UPDATE OR DELETE ON payment_attempts
  FOR EACH ROW
  EXECUTE FUNCTION payment_attempts_guard_mutation();

COMMIT;

-- Left deliberately untouched, per the approved design:
--   * invoices.telr_transaction_id, invoices.pdf_url, invoices.payment_date —
--     no column on invoices is read, written, or otherwise touched by this
--     stage. This stage issues zero UPDATE/DELETE against invoices,
--     subscriptions, or companies (Part A's ALTER TABLE statements change
--     constraints only, never a row's data).
--   * companies.plan / companies.subscription_status — untouched; this
--     stage never activates or changes a subscription's or a company's
--     entitlement state. requireActiveSubscription (middleware/subscription.ts)
--     reads only those two columns and trial_end_date; nothing here is on
--     that code path.
--   * No new queue, worker, scheduler, or email is introduced. No frontend
--     change accompanies this migration.
