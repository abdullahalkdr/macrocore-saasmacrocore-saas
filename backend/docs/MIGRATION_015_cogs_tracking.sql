-- Dashboard/reports P&L rebuild: "profit" so far was just revenue - expenses,
-- ignoring the cost of the ingredients actually consumed. This adds a
-- cost_of_goods column to sales and waste_records, populated at write time from
-- the FIFO consumeRawMaterial() weighted-average cost (already computed on every
-- sale/waste record, just never persisted before) — so reports can show a real
-- gross-margin-aware profit figure: revenue - COGS - waste cost - expenses - payroll.
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS cost_of_goods DECIMAL(10,3);

ALTER TABLE waste_records
  ADD COLUMN IF NOT EXISTS cost_of_goods DECIMAL(10,3);
