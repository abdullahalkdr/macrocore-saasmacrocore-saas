-- MIGRATION_082_subscription_lifecycle_foundation.sql
-- Stage B2 — subscription activation (see
-- claude/chat4a-b2-subscription-billing-foundation-proposal-2026-09-15.md).
--
-- Additive only. Every new column is NOT NULL with NO DEFAULT, which means
-- this migration WILL FAIL if the subscriptions table already has even one
-- row — that failure is deliberate and safe (no partial/silent state), not a
-- bug to work around. See PREFLIGHT_B2_subscriptions_schema_check.js, which
-- must be run against the real database and its output reviewed BEFORE this
-- file is ever run there. If that check finds existing rows, STOP — do not
-- run this migration as-is. The smallest compatible alternative for a
-- non-empty table (nullable columns + a follow-up backfill/cleanup step) is
-- intentionally NOT included here, since it would require fabricating
-- currency/price/period values this document has no authority to invent —
-- see the B2 proposal's review-response for the full reasoning.
--
-- No production writes, no execution against any real database, have
-- happened as part of preparing this file. It has been verified only
-- against a disposable, throwaway sandbox Postgres instance created solely
-- for that purpose (see B2's SMOKE_B2_subscription_activation_concurrency.js
-- for the same disposable-DB convention B1 used).
--
-- Run from backend/: node scripts/run-sql.js docs/MIGRATION_082_subscription_lifecycle_foundation.sql

BEGIN;

ALTER TABLE subscriptions
  ADD COLUMN currency VARCHAR(3) NOT NULL,
  ADD COLUMN billing_interval VARCHAR(10) NOT NULL,
  ADD COLUMN current_period_start TIMESTAMPTZ NOT NULL,
  ADD COLUMN current_period_end TIMESTAMPTZ NOT NULL,
  ADD COLUMN period_amount DECIMAL(10,3) NOT NULL,
  ADD CONSTRAINT subscriptions_currency_supported CHECK (currency IN ('USD','KWD')),
  ADD CONSTRAINT subscriptions_billing_interval_valid CHECK (billing_interval IN ('monthly','annual')),
  ADD CONSTRAINT subscriptions_period_amount_positive CHECK (period_amount > 0),
  ADD CONSTRAINT subscriptions_period_end_after_start CHECK (current_period_end > current_period_start);

-- Enforces "at most one live (active/past_due) subscription per company" —
-- the mechanism activateSubscription's conflict-handling and updateCompany's
-- legacy-PATCH guard both depend on. 'cancelled' is deliberately excluded so
-- a cancelled row can coexist with a later fresh activation (no un-cancel —
-- a returning company gets a new row). 'past_due' is included even though
-- this stage never produces it, so this index does not need to change when
-- a later stage adds that transition.
CREATE UNIQUE INDEX subscriptions_one_live_per_company
  ON subscriptions (company_id)
  WHERE status IN ('active', 'past_due');

COMMIT;
