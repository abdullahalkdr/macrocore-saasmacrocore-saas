-- MIGRATION_068_whatsapp_alerts.sql
--
-- Activity Log roadmap, Phase 02 (real-time alerts, WhatsApp first — channel
-- priority WhatsApp -> email -> Slack/Teams was locked by Abdullah on the roadmap
-- artifact). Scope locked via AskUserQuestion before writing any code:
--   1. Trigger events: ALL SENSITIVE_ACTIONS (same set as the Phase 01 field-diff
--      feature in utils/audit.ts) — not a narrower subset.
--   2. Recipient: one fixed WhatsApp number per company (not a list) — set once in
--      Settings > Company > Preferences.
--
-- Two new columns on `companies`:
--   whatsapp_alert_number   — E.164 phone number (e.g. +9655xxxxxxx), nullable.
--   whatsapp_alerts_enabled — off by default so nothing sends until a company
--                             deliberately turns it on (and has entered a number).
--
-- NOTE: sending itself needs WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID env
-- vars on the API service (Abdullah's own Meta Business Platform / WhatsApp Cloud
-- API app), which do not exist yet as of this migration (2026-08-26). Until they're
-- set, backend/src/utils/whatsapp.ts's sendWhatsAppAlert() is a deliberate no-op —
-- this migration and the rest of the pipeline are safe to run and ship today.
--
-- Run: node scripts/run-sql.js docs/MIGRATION_068_whatsapp_alerts.sql

ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp_alert_number VARCHAR(20);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp_alerts_enabled BOOLEAN NOT NULL DEFAULT false;
