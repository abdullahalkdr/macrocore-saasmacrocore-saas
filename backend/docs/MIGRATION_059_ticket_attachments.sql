-- MIGRATION_059_ticket_attachments.sql
--
-- ITSM Helpdesk: file attachments on tickets and their replies. Real-world gap
-- caught in production — an IT agent asked a requester for a screenshot, and
-- there was no UI to upload one anywhere in the ticket flow.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_059_ticket_attachments.sql
--
-- Design decisions:
--   1. JSONB array of {file_name, file_base64} objects, same storage
--      convention as company_files.file_base64 / employees' document uploads
--      (base64 data URLs stored directly — no S3/object storage in this
--      project). The difference here is a ticket/reply can carry MULTIPLE
--      files (a screenshot + a log export, say), so a JSONB array on the row
--      itself is simpler than a new child table — same reasoning
--      support_tickets.dynamic_data already uses JSONB for a flexible list
--      of values rather than a rigid child table.
--   2. NOT NULL DEFAULT '[]'::jsonb on both, not nullable — every existing
--      row (support_tickets and ticket_replies) gets a real empty array on
--      migrate, so the frontend/backend never has to null-check this
--      differently from "no attachments".
--   3. Size/count limits (max 5 files, 5MB decoded per file) are enforced in
--      the application layer (supportTickets.controller.ts's
--      validateAttachments()), not in SQL — same split as
--      validateDynamicData()'s field-shape checks for dynamic_data.
--   4. The real table for ticket replies is `ticket_replies` (confirmed by
--      reading supportTickets.controller.ts's reply() controller) — NOT
--      `support_ticket_replies`, which doesn't exist in this schema.
--
-- Style notes (same conventions as MIGRATION_044 onward): IF NOT EXISTS /
-- idempotent throughout — safe to run more than once.

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE ticket_replies
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
