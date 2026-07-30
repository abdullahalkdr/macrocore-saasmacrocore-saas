-- macrocore.io — Migration 006 (Location-based inventory: kiosk/warehouse split + stock transfers)
-- Additive only in structure (new columns/tables), but this migration DOES tighten one
-- constraint (raw_material_batches.location_id becomes NOT NULL after backfill) — see note below.
-- Safe to run once against the same database MIGRATION_005_raw_material_batches.sql was
-- already applied to.
--
-- Run it the same way you ran migration 005, e.g.:
--   psql "$DATABASE_URL" -f docs/MIGRATION_006_location_inventory.sql

-- ── Location type (kiosk vs warehouse) ─────────────────────────────────────
-- Existing locations default to 'kiosk' — in this business, a single registered
-- location almost always means the kiosk itself, not a warehouse.
ALTER TABLE locations ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'kiosk'; -- kiosk | warehouse

-- ── Batches now belong to a specific location ──────────────────────────────
-- Inventory is no longer company-wide — every batch lives at exactly one location
-- (a kiosk or a warehouse). Stock moves between locations only via stock_transfers below.
ALTER TABLE raw_material_batches ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);

-- Backfill: every existing batch (created before this migration, with no location_id)
-- is assigned to its company's first registered location. If a company has no location
-- at all yet (rare — every company using shifts/sales already needs one), a default
-- "المستودع الرئيسي" (Main Warehouse) location is created for it.
DO $$
DECLARE
  v_company RECORD;
  v_location_id UUID;
BEGIN
  FOR v_company IN SELECT id FROM companies LOOP
    -- Only bother if this company actually has batches missing a location
    IF EXISTS (SELECT 1 FROM raw_material_batches WHERE company_id = v_company.id AND location_id IS NULL) THEN
      SELECT id INTO v_location_id FROM locations WHERE company_id = v_company.id ORDER BY created_at ASC LIMIT 1;

      IF v_location_id IS NULL THEN
        INSERT INTO locations (company_id, name, type)
        VALUES (v_company.id, 'المستودع الرئيسي', 'warehouse')
        RETURNING id INTO v_location_id;
      END IF;

      UPDATE raw_material_batches SET location_id = v_location_id
      WHERE company_id = v_company.id AND location_id IS NULL;
    END IF;
  END LOOP;
END $$;

-- Every batch must belong to a location from now on — no NULL location as a permanent
-- state (that would create a special case in every future stock query / report / UI
-- filter). New batches (via POST /api/raw-material-batches) already require location_id.
ALTER TABLE raw_material_batches ALTER COLUMN location_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_raw_material_batches_location ON raw_material_batches(company_id, location_id, raw_material_id, qty_remaining DESC);

-- ── Stock transfers (warehouse ↔ kiosk, or any location ↔ location) ────────
-- A transfer consumes FIFO from the source location's batches (possibly spanning
-- several source batches) and creates ONE new batch at the destination location.
-- The new batch's purchase_price is the weighted-average cost of what was consumed;
-- its expiry_date is inherited from the earliest (most conservative) expiry_date
-- among the consumed source batches — a transfer never "resets" a shelf-life clock.
CREATE TABLE IF NOT EXISTS stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  raw_material_id UUID NOT NULL REFERENCES raw_materials(id),
  from_location_id UUID NOT NULL REFERENCES locations(id),
  to_location_id UUID NOT NULL REFERENCES locations(id),
  qty DECIMAL(10, 3) NOT NULL,
  new_batch_id UUID REFERENCES raw_material_batches(id), -- the batch created at the destination
  transferred_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_company ON stock_transfers(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_material ON stock_transfers(raw_material_id);
