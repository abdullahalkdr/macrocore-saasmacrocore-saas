-- Task #28: integrated warehouse management on top of the existing FIFO batch/
-- location system. Adds a reorder threshold to raw materials (for low-stock
-- alerts) and a stock_adjustments audit table for manual corrections (physical
-- count corrections, spoilage/loss not tied to a sale or waste record, or
-- "found" stock) that aren't sales, waste, or transfers.
ALTER TABLE raw_materials
  ADD COLUMN IF NOT EXISTS min_stock_qty DECIMAL(10,3);

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  raw_material_id UUID NOT NULL REFERENCES raw_materials(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  qty_delta DECIMAL(10,3) NOT NULL, -- positive = stock added ("found"), negative = stock removed (loss/shrinkage/count correction)
  reason VARCHAR(255) NOT NULL,
  new_batch_id UUID REFERENCES raw_material_batches(id), -- set when qty_delta > 0 (the batch created to hold the added stock)
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_adjustments_company ON stock_adjustments(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_material_location ON stock_adjustments(raw_material_id, location_id);
