-- Fixes a real bug: raw_material_batches.qty_purchased/qty_remaining were compared
-- directly against recipe consumption (which IS converted to base units — grams/ml/pcs
-- — via UNIT_TO_BASE) with no conversion of their own. A batch entered as "50" meaning
-- 50kg was read as 50 base units (50g), causing false "insufficient stock" errors.
--
-- Fix: every batch now records its own unit, always set to the raw material's
-- package_unit at creation time (not user-chosen — one unit per material, matching
-- what the Inventory Overview page already displays). consumeRawMaterial/transferStock
-- convert using this unit before comparing/deducting.
ALTER TABLE raw_material_batches ADD COLUMN IF NOT EXISTS unit VARCHAR(10);

-- Test-only data as of this migration (confirmed with Abdullah) — safe to backfill a
-- best guess from the material's package_unit rather than needing a precise migration.
UPDATE raw_material_batches rb
SET unit = rm.package_unit
FROM raw_materials rm
WHERE rb.raw_material_id = rm.id AND rb.unit IS NULL AND rm.package_unit IS NOT NULL;
UPDATE raw_material_batches SET unit = 'g' WHERE unit IS NULL;

ALTER TABLE raw_material_batches ALTER COLUMN unit SET NOT NULL;
ALTER TABLE raw_material_batches ALTER COLUMN unit SET DEFAULT 'g';
