-- MIGRATION_057_ticket_smart_numbering.sql
--
-- Enterprise "Smart Numbering" for support tickets: a human-readable
-- ticket_number (e.g. IT-2608-0001) instead of forcing agents/approvers to
-- communicate about a ticket by its raw UUID. Format: [DEPT]-[YYMM]-[XXXX] —
-- department code, then the 2-digit year + 2-digit month the ticket was
-- created in, then a 4-digit zero-padded sequence number.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_057_ticket_smart_numbering.sql
--
-- Design decisions:
--   1. departments.code (VARCHAR(10), nullable) — a short human prefix like
--      'IT'/'HR'/'FIN', separate from the existing free-text cost_center_code
--      (MIGRATION_049) which serves a different purpose (an accounting tag,
--      not a document-numbering prefix). Nullable: an existing company's
--      custom departments won't have one set until an admin fills it in via
--      the Departments page — supportTickets.controller.ts's create() falls
--      back to the generic 'GEN' prefix whenever a department has no code
--      (or the ticket's creator has no department at all), so numbering never
--      breaks, it just isn't department-specific until configured.
--   2. document_sequences — a generic, reusable monotonic counter keyed by
--      (company_id, prefix), not a ticket-specific table. Deliberately not
--      tied to support_tickets at all: the SAME mechanism can back invoice
--      numbers, PO numbers, or any other document type later by just picking
--      a different prefix scheme, without a new table per document type.
--   3. The month lives INSIDE the prefix (e.g. 'IT-2608'), not as a separate
--      column — this means the counter naturally resets to 1 every month per
--      department for free: a new (company_id, prefix) row is simply created
--      the first time that department+month combination is used
--      (see backend/src/utils/sequences.ts's generateNextSequence). No cron,
--      no month-rollover job.
--   4. current_value starts at 0, not 1 — generateNextSequence() always reads
--      then increments, so the first ticket in a new prefix becomes 0001, not
--      0000 or 0002. UNIQUE(company_id, prefix) is the row that
--      "SELECT ... FOR UPDATE" locks inside that function's transaction —
--      that row lock, not the UNIQUE constraint itself, is what prevents two
--      concurrent ticket creations from ever being handed the same number.
--   5. support_tickets.ticket_number is nullable and NOT backfilled for
--      existing tickets — a legacy ticket simply has no ticket_number
--      (frontend falls back to showing nothing/the old UUID-based reference
--      where needed). Retroactively numbering old tickets would require
--      picking an artificial creation-order-based scheme that has no real
--      meaning; out of scope here.
--   6. Seeds `code` for the 6 default departments MIGRATION_048 creates for
--      every company (HR/Operations/Marketing/IT/Finance/Legal) so the
--      feature works immediately without every existing company's admin
--      having to configure codes by hand first. Only sets code where it's
--      still NULL — never overwrites a code an admin may have already set
--      by hand before this migration ran (not possible before this file
--      existed, but keeps the UPDATE idempotent/safe to re-run regardless).
--
-- Style notes (same conventions as MIGRATION_044 onward): no native Postgres
-- ENUM types, no updated_at triggers, IF NOT EXISTS / idempotent throughout —
-- safe to run more than once.

-- ========================================================================
-- 1. departments.code
-- ========================================================================

ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS code VARCHAR(10);

UPDATE departments SET code = 'HR'  WHERE code IS NULL AND name_en = 'Human Resources';
UPDATE departments SET code = 'OPS' WHERE code IS NULL AND name_en = 'Operations';
UPDATE departments SET code = 'MKT' WHERE code IS NULL AND name_en = 'Marketing';
UPDATE departments SET code = 'IT'  WHERE code IS NULL AND name_en = 'IT';
UPDATE departments SET code = 'FIN' WHERE code IS NULL AND name_en = 'Finance';
UPDATE departments SET code = 'LEG' WHERE code IS NULL AND name_en = 'Legal';

-- ========================================================================
-- 2. document_sequences — generic concurrency-safe counter, see decision 2/4.
-- ========================================================================

CREATE TABLE IF NOT EXISTS document_sequences (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  prefix         VARCHAR(50) NOT NULL,
  current_value  INT NOT NULL DEFAULT 0,

  UNIQUE (company_id, prefix)
);

-- ========================================================================
-- 3. support_tickets.ticket_number
-- ========================================================================

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS ticket_number VARCHAR(50);
