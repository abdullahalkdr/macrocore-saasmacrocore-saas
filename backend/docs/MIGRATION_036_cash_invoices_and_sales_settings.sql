-- "فواتير نقدية" (Cash Invoices) reuse the sales_invoices table (same shape, no need
-- for a separate table) — distinguished by `type`. A cash invoice is paid at creation
-- time (see salesInvoices.controller.ts create()): status is forced to 'paid' and
-- amount_paid = total immediately, skipping the draft/sent workflow real invoices go
-- through. The regular Sales Invoices page only ever shows type = 'invoice'.
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS type VARCHAR(10) NOT NULL DEFAULT 'invoice' CHECK (type IN ('invoice', 'cash'));
CREATE INDEX IF NOT EXISTS idx_sales_invoices_type ON sales_invoices(company_id, type);

-- "إعداد المبيعات" (Sales Settings) — a single default-notes text prefilled onto new
-- quotes/invoices/credit notes/cash invoices (editable per document either way). Kept
-- minimal on purpose — this is not a full settings module, just the one thing that
-- actually saves repetitive typing.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_sales_notes TEXT;
