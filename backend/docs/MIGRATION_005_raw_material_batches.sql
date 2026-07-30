-- macrocore.io — Migration 005 (Raw Material Batches + FIFO inventory management)
-- Additive only — does not touch existing columns or data. Safe to run once
-- against the same database MIGRATION_004_attendance_hr.sql was already applied to.
--
-- This migration adds FIFO (First-In-First-Out) inventory tracking at the batch level.
-- Each purchase of a raw material now creates a batch record, tracking:
--   - quantity purchased and remaining
--   - purchase date and optional expiry date
--   - actual purchase price (may differ per batch due to market fluctuations)
--
-- Existing raw_materials.qty_available (if present) becomes a historical batch
-- on the migration date, and future consumption uses FIFO from the new batches table.
--
-- Run it the same way you ran migration 004, e.g.:
--   psql "$DATABASE_URL" -f docs/MIGRATION_005_raw_material_batches.sql

-- ── Raw Material Batches (FIFO inventory) ──────────────────────────────────
-- Each batch represents one "purchase event" — a quantity bought at a specific price.
-- qty_remaining decreases as the batch is consumed (via sales, waste, etc.) following FIFO order.
-- Once qty_remaining reaches 0, the batch is considered exhausted but kept for audit/historical purposes.
CREATE TABLE IF NOT EXISTS raw_material_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  raw_material_id UUID NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
  purchase_date DATE NOT NULL,
  expiry_date DATE, -- optional; used for alerts and FIFO ordering of expired batches first
  qty_purchased DECIMAL(10, 3) NOT NULL,
  qty_remaining DECIMAL(10, 3) NOT NULL,
  purchase_price DECIMAL(10, 3) NOT NULL, -- actual unit price per package (same meaning as raw_materials.purchase_price)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_raw_material_batches_company ON raw_material_batches(company_id);
CREATE INDEX IF NOT EXISTS idx_raw_material_batches_material ON raw_material_batches(raw_material_id, qty_remaining DESC);
CREATE INDEX IF NOT EXISTS idx_raw_material_batches_expiry ON raw_material_batches(expiry_date);

-- ── Initial batch migration ────────────────────────────────────────────────
-- If raw_materials has a qty_available column (from older versions), create one historical batch
-- per raw material to represent existing inventory. Uses TODAY as purchase_date.
-- This is a one-time operation; running this migration multiple times won't re-import.
--
-- If raw_materials.qty_available doesn't exist, this silently does nothing (no error).
-- You will then manually add batches via the API/UI once you're ready to track inventory.

-- Check if raw_materials has qty_available column; if so, migrate it to the first batch
DO $$
DECLARE
  v_column_exists BOOLEAN;
  v_raw_material RECORD;
BEGIN
  -- Check if qty_available column exists
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'raw_materials'
    AND column_name = 'qty_available'
  ) INTO v_column_exists;

  IF v_column_exists THEN
    -- For each raw material with qty_available > 0, create a batch
    FOR v_raw_material IN
      SELECT id, company_id, purchase_price FROM raw_materials WHERE qty_available > 0
    LOOP
      INSERT INTO raw_material_batches (
        company_id,
        raw_material_id,
        purchase_date,
        expiry_date,
        qty_purchased,
        qty_remaining,
        purchase_price,
        created_at,
        updated_at
      ) VALUES (
        v_raw_material.company_id,
        v_raw_material.id,
        CURRENT_DATE,
        NULL,
        (SELECT qty_available FROM raw_materials WHERE id = v_raw_material.id),
        (SELECT qty_available FROM raw_materials WHERE id = v_raw_material.id),
        COALESCE(v_raw_material.purchase_price, 0),
        NOW(),
        NOW()
      );
    END LOOP;
  END IF;
END $$;

-- After batches are created, you may optionally drop qty_available from raw_materials
-- (not done here to preserve backward compatibility with old queries).
-- If you want to clean it up later, you can:
--   ALTER TABLE raw_materials DROP COLUMN IF EXISTS qty_available;
