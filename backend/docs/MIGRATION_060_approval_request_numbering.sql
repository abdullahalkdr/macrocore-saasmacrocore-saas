-- MIGRATION_060_approval_request_numbering.sql
--
-- Adds a human-readable request_number to approval_requests (e.g. APR-2608-0001),
-- reusing MIGRATION_057's generic document_sequences counter (the same mechanism
-- support_tickets.ticket_number already uses) instead of inventing a new counter
-- table. Also links notifications to the approval_requests row they're about, so a
-- resolved request's pending-approval notifications can be auto-cleared regardless
-- of which surface resolved it.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_060_approval_request_numbering.sql
--
-- Design decisions:
--   1. request_number is nullable and NOT backfilled for existing approval_requests
--      rows -- same call MIGRATION_057 made for support_tickets.ticket_number. A
--      legacy request simply has no number; the frontend shows nothing extra for it.
--   2. Reuses document_sequences (MIGRATION_057) with a fixed 'APR' prefix -- one
--      more document type riding the same generic (company_id, prefix) counter, per
--      that migration's own stated intent. No department distinction needed here
--      (unlike tickets): a company's approval requests span every module type in
--      one shared feed, numbered in one sequence per month.
--   3. notifications.approval_request_id is a nullable FK, ON DELETE SET NULL -- only
--      ever set on 'approval_pending' notifications (backend/src/utils/notifications.ts).
--      Lets approvals.controller.ts's actionRequest() mark every notification tied to
--      a request as read the moment ANY path resolves it. Previously a pending-approval
--      notification only ever cleared if you clicked through that exact notification --
--      approving the same request from the Approvals Inbox directly left it stuck
--      "unread" in the bell forever, pointing at an already-resolved request.
--
-- Run again after any migration: safe, IF NOT EXISTS / idempotent throughout.

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS request_number VARCHAR(30);

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS approval_request_id UUID REFERENCES approval_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_approval_request
  ON notifications (approval_request_id) WHERE approval_request_id IS NOT NULL;
