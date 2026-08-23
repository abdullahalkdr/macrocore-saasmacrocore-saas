-- MIGRATION_047_pivot_to_itsm_service_desk.sql
-- ITSM Service Desk pivot, Step 1 (schema only) — introduces a two-layer
-- Jira-style service catalog (service_categories -> service_request_types,
-- each request type carrying its own dynamic custom fields) alongside the
-- existing flat ticket_categories/support_tickets.category_id system from
-- MIGRATION_046, plus a data migration that backfills every existing
-- ticket_categories row into the new tables so no live data is orphaned.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_047_pivot_to_itsm_service_desk.sql
--
-- Decisions applied here (full log: helpdesk-itsm-pivot-decision.md in the
-- Claude Project, decided 2026-08-23 before this file was written):
--
--   1. FULL REPLACEMENT of ticket_categories, WITH data migration (not a
--      permanent parallel system). ticket_categories and
--      support_tickets.category_id are left in place and untouched by this
--      file — they are not dropped here. They become deprecated once the
--      Step 2 backend/Step 3 frontend cutover onto request_type_id is built
--      and verified; dropping them is a future migration, not this one.
--
--   2. NO new assignee_id column. support_tickets.assigned_to UUID
--      REFERENCES users(id) already exists (added before this project
--      touched the ticketing system) and is already read/written by
--      supportTickets.controller.ts's TICKET_FIELDS — agent-assignment work
--      in a later step targets that existing column.
--
--   3. Two deviations from the original pivot spec, both following this
--      repo's own established conventions (documented again here so this
--      file doesn't need cross-referencing MIGRATION_044/046):
--        a) Added created_at/updated_at TIMESTAMP DEFAULT now() to all three
--           new tables. Every other per-company config table in this schema
--           has them (ticket_categories, sla_policies, etc.); the original
--           pivot spec's column list simply omitted them.
--        b) Added is_hr_sensitive BOOLEAN NOT NULL DEFAULT false to
--           service_request_types — NOT in the original pivot spec at all.
--           The live HR-ticket-isolation feature (visibilityFilter() /
--           canAccessTicket() in supportTickets.controller.ts) currently
--           reads ticket_categories.is_hr_sensitive to decide whether a
--           ticket is hidden from roles without the 'view_hr_tickets'
--           permission. A "full replacement" migration that dropped this
--           property without giving it a new home would silently break that
--           isolation the moment Step 2 cuts reads over to request_type_id.
--           Placed on service_request_types (the leaf table actually
--           referenced by support_tickets.request_type_id) rather than
--           service_categories, since "is this specific service HR-
--           sensitive" is a request-type-level fact — matches how the
--           legacy flat list already let sibling categories differ
--           independently (e.g. "Leave" and "IT" were both plain top-level
--           entries, not grouped under a shared parent).
--
-- Style notes (same conventions this schema has used since MIGRATION_044):
--   - No native Postgres ENUM types — VARCHAR + CHECK only (see
--     service_custom_fields.field_type below).
--   - No updated_at triggers — set manually per UPDATE query, Step 2's job.
--   - IF NOT EXISTS / idempotent throughout, per the pivot request's own
--     migration rules — safe to run more than once.

-- ========================================================================
-- 1. service_categories — the portal home. Broad groupings a company sets
--    up once (e.g. "Computers", "Logins and Accounts", "Applications").
-- ========================================================================

CREATE TABLE IF NOT EXISTS service_categories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  name            VARCHAR(120) NOT NULL,
  name_en         VARCHAR(120),
  description     VARCHAR(500),
  description_en  VARCHAR(500),
  icon            VARCHAR(60),

  created_at      TIMESTAMP DEFAULT now(),
  updated_at      TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_categories_company_id ON service_categories (company_id);

-- ========================================================================
-- 2. service_request_types — the specific services under a category (e.g.
--    "Request new software", "Fix an account problem"). This is the leaf
--    tickets actually attach to (support_tickets.request_type_id, below).
-- ========================================================================

CREATE TABLE IF NOT EXISTS service_request_types (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id     UUID REFERENCES service_categories(id) ON DELETE CASCADE,

  name            VARCHAR(120) NOT NULL,
  name_en         VARCHAR(120),
  description     VARCHAR(500),
  description_en  VARCHAR(500),

  -- Not in the original pivot spec — see decision 3(b) in the header.
  is_hr_sensitive BOOLEAN NOT NULL DEFAULT false,

  -- Idempotency marker for the data-migration block below only (section 5)
  -- — lets this file re-run safely without creating duplicate request types
  -- for the same source ticket_categories row. Not part of the pivot spec;
  -- purely a migration-tooling column.
  source_ticket_category_id UUID,

  created_at      TIMESTAMP DEFAULT now(),
  updated_at      TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_request_types_company_id ON service_request_types (company_id);
CREATE INDEX IF NOT EXISTS idx_service_request_types_category_id ON service_request_types (category_id);

-- ========================================================================
-- 3. service_custom_fields — dynamic form builder. Per-request-type custom
--    fields (e.g. a "Reason" textarea, a "Number of Licenses" number field).
--    Table only in this step — no validation/storage logic yet (Step 2).
-- ========================================================================

CREATE TABLE IF NOT EXISTS service_custom_fields (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  request_type_id  UUID REFERENCES service_request_types(id) ON DELETE CASCADE,

  field_key        VARCHAR(60) NOT NULL,
  field_label      VARCHAR(120) NOT NULL,
  field_label_en   VARCHAR(120),

  -- VARCHAR + CHECK, not a native ENUM — repo convention (MIGRATION_044's
  -- header comment; reconfirmed in MIGRATION_046).
  field_type       VARCHAR(20) NOT NULL DEFAULT 'text'
                    CHECK (field_type IN ('text', 'textarea', 'number', 'dropdown')),
  is_required      BOOLEAN NOT NULL DEFAULT false,

  created_at       TIMESTAMP DEFAULT now(),
  updated_at       TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_custom_fields_request_type_id ON service_custom_fields (request_type_id);

-- ========================================================================
-- 4. support_tickets — new columns for the ITSM model. No assignee_id (see
--    decision 2 above) — assigned_to already covers that. Backward
--    compatible: an existing ticket just has NULL request_type_id and empty
--    dynamic_data until section 5 backfills it (every ticket that had a
--    category_id gets one; a ticket with only the legacy `category` string
--    is untouched — that fallback still isn't migrated by this file, same
--    as MIGRATION_046 left it for Step 2 to decide).
-- ========================================================================

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS request_type_id UUID REFERENCES service_request_types(id) ON DELETE SET NULL;

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS dynamic_data JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_support_tickets_request_type_id ON support_tickets (request_type_id);

-- ========================================================================
-- 5. Data migration — backfill every existing ticket_categories row into
--    the new two-layer model, and repoint any ticket that used it.
--
--    One service_category per source row (same name/name_en), plus exactly
--    one 1:1 service_request_type nested under it (same name/name_en again,
--    is_hr_sensitive carried over). This preserves today's flat one-level
--    behavior exactly — every category a tenant already has becomes
--    immediately usable in the new model with zero manual setup — while the
--    schema is now ready for a tenant to later split one category into
--    several distinct request types by hand.
--
--    ticket_categories itself, and support_tickets.category_id, are left
--    completely untouched by this block — this only adds new rows and
--    backfills the new request_type_id column.
-- ========================================================================

DO $$
DECLARE
  src RECORD;
  new_category_id UUID;
  new_request_type_id UUID;
BEGIN
  FOR src IN SELECT * FROM ticket_categories LOOP
    IF NOT EXISTS (
      SELECT 1 FROM service_request_types WHERE source_ticket_category_id = src.id
    ) THEN
      INSERT INTO service_categories (company_id, name, name_en)
      VALUES (src.company_id, src.name, src.name_en)
      RETURNING id INTO new_category_id;

      INSERT INTO service_request_types
        (company_id, category_id, name, name_en, is_hr_sensitive, source_ticket_category_id)
      VALUES
        (src.company_id, new_category_id, src.name, src.name_en, src.is_hr_sensitive, src.id)
      RETURNING id INTO new_request_type_id;

      UPDATE support_tickets
        SET request_type_id = new_request_type_id
        WHERE category_id = src.id;
    END IF;
  END LOOP;
END $$;
