-- MIGRATION_076_email_foundation.sql
-- Macrocore Email System, Chat 1 — shared transactional-email foundation.
--
-- Adds:
--   1. A generic email_log table for delivery tracking, reusable by every email
--      category this chat and future chats (Helpdesk/SLA, Billing/Subscriptions)
--      will add — extend by adding new `category` values, never a new table.
--   2. A persisted per-user email-language preference (users.preferred_language),
--      independent of the existing UI-only language toggle
--      (frontend/src/store/langStore.ts, localStorage-only) — emails are sent
--      outside any browser session, so the server needs its own known value.
--
-- Both changes are purely additive: no existing column or table is altered or
-- dropped. Safe to run against the live database with zero downtime.
--
-- Run: node scripts/run-sql.js docs/MIGRATION_076_email_foundation.sql

CREATE TABLE IF NOT EXISTS email_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID REFERENCES companies(id) ON DELETE CASCADE,
  category            VARCHAR(50) NOT NULL,
  recipient_email     VARCHAR(255) NOT NULL,
  subject             TEXT NOT NULL,
  status              VARCHAR(20) NOT NULL CHECK (status IN ('sent', 'failed', 'dev_skipped')),
  resend_message_id   VARCHAR(255),
  related_entity_type VARCHAR(50),
  related_entity_id   UUID,
  error               TEXT,
  created_at          TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_log_company_created ON email_log (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_log_category ON email_log (category);
CREATE INDEX IF NOT EXISTS idx_email_log_related ON email_log (related_entity_type, related_entity_id);

-- Defaults every existing row to 'ar' — matches the app's own existing default
-- (frontend/src/store/langStore.ts: "Defaults to Arabic — this is a Kuwait-market
-- product"). No backfill script needed beyond the column default itself.
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(2) NOT NULL DEFAULT 'ar';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_preferred_language_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_preferred_language_check CHECK (preferred_language IN ('ar', 'en'));
  END IF;
END $$;
