-- Per-line discount (%) on quotes/invoices/credit notes — the one field from the Wafeq
-- reference's toggleable-columns panel that has a real, honest place in macrocore:
-- unlike "حساب" (GL account) and "مركز التكلفة" (cost center), which have no backing
-- feature here (cost centers is itself still a "coming soon" placeholder elsewhere in
-- the app), a discount percentage needs no accounting system behind it to work —
-- line_total is simply qty * unit_price * (1 - discount_pct/100).
ALTER TABLE sales_quote_items ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_invoice_items ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_credit_note_items ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
