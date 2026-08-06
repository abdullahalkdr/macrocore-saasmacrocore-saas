-- "سندات العملاء" (Customer Receipts) — records a payment received from a customer,
-- optionally applied against one sales_invoice. Applying to an invoice bumps that
-- invoice's amount_paid (see customerReceipts.controller.ts create()) rather than the
-- receipt itself carrying any derived state, so the invoice stays the single source of
-- truth for how much of it has been paid.
CREATE TABLE IF NOT EXISTS customer_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  invoice_id UUID REFERENCES sales_invoices(id) ON DELETE SET NULL,
  amount NUMERIC(12,3) NOT NULL,
  receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
  method VARCHAR(30) NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'bank_transfer', 'card', 'knet', 'cheque', 'other')),
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_receipts_company ON customer_receipts(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_receipts_customer ON customer_receipts(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_receipts_invoice ON customer_receipts(invoice_id);
