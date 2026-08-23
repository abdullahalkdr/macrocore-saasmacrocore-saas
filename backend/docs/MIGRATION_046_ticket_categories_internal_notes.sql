-- MIGRATION_046_ticket_categories_internal_notes.sql
-- Helpdesk enhancement — extends the EXISTING support_tickets / ticket_replies
-- system (built in MIGRATION_043_hrms_performance_sla.sql) instead of creating
-- a parallel `tickets` table. Decision made 2026-08-22 after finding the
-- original "build a Helpdesk module" request would have duplicated a live,
-- already-wired system (supportTickets.controller.ts / supportTickets.routes.ts,
-- mounted with requireAuth + requireRole, already handling create/list/reply/
-- status/SLA). See ticket_replies visibility note in section 2 for the actual
-- new capability this migration adds.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_046_ticket_categories_internal_notes.sql
--
-- Style notes (same conventions MIGRATION_044/045 already documented for this
-- schema — repeating them here so this file doesn't need cross-referencing):
--   - No native Postgres ENUM types — VARCHAR + CHECK only.
--   - No updated_at triggers — set manually in each UPDATE query, Step 2's job.
--   - Additive only. Nothing below drops or renames an existing column; the
--     legacy `support_tickets.category` VARCHAR(30) (from MIGRATION_043) and
--     `ticket_replies.is_admin_reply` stay exactly as they are and stay
--     authoritative until Step 2 explicitly migrates read/write paths.

-- ========================================================================
-- 1. ticket_categories — per-company, bilingual, replaces the hardcoded
--    CATEGORIES array in supportTickets.controller.ts (general | leave |
--    grievance | document_request | payroll | it | other) with a table
--    tenants can extend (e.g. "New Menu Request" / "طلب قائمة جديدة").
-- ========================================================================

CREATE TABLE IF NOT EXISTS ticket_categories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  name            VARCHAR(100) NOT NULL,
  name_en         VARCHAR(100),

  -- Mirrors the controller's current HR_CATEGORIES gate (leave/grievance/
  -- document_request/payroll are hidden from admin/manager without the
  -- 'view_hr_tickets' permission). Step 2 replaces that hardcoded array with
  -- a lookup against this column so a tenant-defined category can also be
  -- marked sensitive.
  is_hr_sensitive BOOLEAN NOT NULL DEFAULT false,

  created_at      TIMESTAMP DEFAULT now(),
  updated_at      TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_categories_company_id ON ticket_categories (company_id);

-- ========================================================================
-- 2. support_tickets.category_id — additive FK alongside the existing
--    `category` VARCHAR column. Nullable: no rows are seeded here (Step 2
--    decides whether to auto-seed the 7 existing hardcoded categories per
--    company, or leave category selection to each tenant). ON DELETE SET
--    NULL so removing a category never takes a ticket down with it.
--
--    Note for Step 2: category_id.company_id must be validated against the
--    ticket's own company_id at the controller level (a plain FK can't
--    enforce "same tenant" across two tables) — same pattern already used
--    for canAccessTicket()'s other cross-row checks.
-- ========================================================================

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES ticket_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_support_tickets_category_id ON support_tickets (category_id);

-- ========================================================================
-- 3. ticket_replies.is_internal_note — the actual new feature the original
--    request was after ("Internal Notes hidden from standard users, visible
--    only to admins/support staff"). Distinct from is_admin_reply, which only
--    marks *who* wrote a reply (attribution) and is currently always visible
--    to anyone who can see the ticket. is_internal_note instead controls
--    *visibility*: Step 2's getOne() must exclude rows where this is true
--    from the response given to the ticket's own creator (a plain employee
--    reading their own ticket should never see it), matching the same
--    "hidden from standard users" contract the request describes.
-- ========================================================================

ALTER TABLE ticket_replies
  ADD COLUMN IF NOT EXISTS is_internal_note BOOLEAN NOT NULL DEFAULT false;

-- Defensive: ticket_replies predates the numbered migrations in this docs/
-- folder (not created by any MIGRATION_0NN file — likely part of the original
-- baseline schema), so its indexing can't be confirmed by reading migration
-- history. getOne() filters on ticket_id on every request; IF NOT EXISTS
-- makes this a no-op if the index is already there.
CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket_id ON ticket_replies (ticket_id);
