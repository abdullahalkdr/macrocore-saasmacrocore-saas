-- "إشعارات دائنة" (Credit Notes) — a standalone document for returns/discounts/
-- corrections, same shape as sales_quotes/sales_invoices. source_invoice_id is kept
-- for context only (which invoice this credit relates to) — issuing a credit note does
-- NOT rewrite the original invoice's total/amount_paid. Mutating a historical invoice's
-- numbers automatically would be an accounting correctness risk; staff reconcile the
-- two documents manually, same cautious spirit as sales_quotes not auto-converting into
-- sales_invoices yet.
CREATE TABLE IF NOT EXISTS sales_credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number VARCHAR(30) NOT NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  source_invoice_id UUID REFERENCES sales_invoices(id) ON DELETE SET NULL,
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued')),
  notes TEXT,
  subtotal NUMERIC(12,3) NOT NULL DEFAULT 0,
  total NUMERIC(12,3) NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales_credit_note_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id UUID NOT NULL REFERENCES sales_credit_notes(id) ON DELETE CASCADE,
  description VARCHAR(500) NOT NULL,
  qty NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,3) NOT NULL DEFAULT 0,
  line_total NUMERIC(12,3) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sales_credit_notes_company ON sales_credit_notes(company_id);
CREATE INDEX IF NOT EXISTS idx_sales_credit_note_items_note ON sales_credit_note_items(credit_note_id);
