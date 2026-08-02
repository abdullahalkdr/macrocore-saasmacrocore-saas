-- Shift-close reconciliation: physical product count vs system-expected remaining,
-- and a cash-drawer denomination count vs expected cash sales. cash_denominations
-- already existed (created earlier, never wired up) — this just adds the two missing
-- columns needed to record the count and any closing note.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS closing_notes TEXT;
ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS actual_remaining_qty DECIMAL(10, 3);
