-- macrocore.io — Migration 003 (Product size variants: S/M/L)
-- Additive only — does not touch existing columns or data. Safe to run once
-- against the same database MIGRATION_002_priority1.sql was already applied to.
--
-- Run it the same way you ran migration 002, e.g.:
--   psql "$DATABASE_URL" -f docs/MIGRATION_003_product_sizes.sql

-- A product either sells at one flat sell_price (has_sizes = false, unchanged behavior)
-- or offers size variants, each with its own price and recipe (has_sizes = true).
ALTER TABLE products ADD COLUMN IF NOT EXISTS has_sizes BOOLEAN DEFAULT false;

CREATE TABLE IF NOT EXISTS product_sizes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  name_en VARCHAR(100),
  sell_price DECIMAL(10, 3),
  sort_order INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_product_sizes_product ON product_sizes(product_id);

-- Mirrors product_ingredients, but per size — a Large usually uses more of an
-- ingredient than a Small, not just a price multiplier.
CREATE TABLE IF NOT EXISTS product_size_ingredients (
  product_size_id UUID NOT NULL REFERENCES product_sizes(id) ON DELETE CASCADE,
  raw_material_id UUID NOT NULL REFERENCES raw_materials(id),
  usage_qty DECIMAL(10, 3),
  usage_unit VARCHAR(20),
  UNIQUE (product_size_id, raw_material_id)
);

-- Shift assignments and sales need to know which size variant of stock they're
-- tracking/selling. NULL means "no size" (has_sizes = false products, unchanged).
ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS product_size_id UUID REFERENCES product_sizes(id);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS product_size_id UUID REFERENCES product_sizes(id);
CREATE INDEX IF NOT EXISTS idx_shift_assignments_size ON shift_assignments(product_size_id);
CREATE INDEX IF NOT EXISTS idx_sales_size ON sales(product_size_id);
