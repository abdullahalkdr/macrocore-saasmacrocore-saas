-- MIGRATION_050_enterprise_locations.sql
--
-- Upgrades `locations` from a bare Name/Type/Area/Address kiosk-tracker into
-- an Enterprise Facility record: an accountable manager, a cost center for
-- financial roll-up, and the legal/lease paperwork every real branch or
-- warehouse actually needs tracked (municipality license, lease term).
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_050_enterprise_locations.sql
--
-- Design decisions:
--   1. manager_id -> employees(id) ON DELETE SET NULL — same shape MIGRATION_049
--      just used for departments.manager_id: losing the manager employee record
--      un-assigns the location's manager, it does not block the delete or touch
--      the location itself. Validated cross-tenant in the controller (same
--      pattern as employees.controller.ts's department_id/location_id checks),
--      not via a DB-level company_id-matching constraint — this schema has no
--      precedent for that (see MIGRATION_048 decision 4), so the app layer stays
--      the single source of truth for tenant-scoped FK validation everywhere.
--   2. cost_center_code is a free-text VARCHAR(50), not a FK — same reasoning as
--      MIGRATION_049 decision 3: this project has no chart-of-accounts /
--      cost-center table yet, so it's a plain tag for now, not an invented
--      table this codebase doesn't otherwise need.
--   3. gps_coordinates is a single VARCHAR(255) "lat,lng" free-text field, not a
--      PostGIS point — this project has no other geo/mapping feature, so a
--      lightweight text field (rendered as a "view on map" link in the UI) beats
--      pulling in the PostGIS extension for one column.
--   4. municipality_license / license_expiry_date / lease_expiry_date are plain
--      nullable columns, exactly like company_files' issue_date/expiry_date
--      pair (MIGRATION_009) — days-until-expiry is computed at query time in
--      locations.controller.ts's list(), the same COALESCE(expiry_date::date -
--      CURRENT_DATE, NULL) pattern companyFiles.controller.ts already uses, not
--      stored — a stored value would go stale the instant it's read on any day
--      other than the one it was computed.
--   5. `type` has never had a database-level CHECK — LOCATION_TYPES in
--      locations.controller.ts was the only enforcement (VARCHAR(20), DEFAULT
--      'kiosk', no constraint). This migration adds a real CHECK for the first
--      time, consistent with every other status/type column added since the
--      "no ENUM, use VARCHAR + CHECK" convention was established — guarded by
--      a DO block so re-running this migration doesn't error trying to add a
--      constraint that already exists (ALTER TABLE ... ADD CONSTRAINT has no
--      native IF NOT EXISTS, unlike ADD COLUMN).

ALTER TABLE locations ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS cost_center_code VARCHAR(50);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS gps_coordinates VARCHAR(255);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS municipality_license VARCHAR(100);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS license_expiry_date DATE;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS lease_expiry_date DATE;

CREATE INDEX IF NOT EXISTS idx_locations_manager_id ON locations (manager_id);

-- Existing rows only ever contained 'kiosk' or 'warehouse' (the only two
-- values LOCATION_TYPES ever allowed at the app layer), so validating
-- immediately on ADD (no NOT VALID) is safe here.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_locations_type'
  ) THEN
    ALTER TABLE locations
      ADD CONSTRAINT chk_locations_type
      CHECK (type IN ('kiosk', 'warehouse', 'retail', 'dark_kitchen', 'head_office'));
  END IF;
END $$;
