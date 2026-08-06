-- "عروض أسعار وفواتير مبدئية" (Quotes / proforma invoices) — the first of the new
-- B2B sales-suite documents (see docs/macrocore-خارطة-طريق.md and the Wafeq-style
-- request). Deliberately its own table, not reusing the POS `sales` table: POS sales
-- are one-shot kiosk transactions tied to a shift; a quote is a draft document with no
-- shift/cash-register concept at all, sent to a business customer before any money
-- moves. No tax/VAT columns — Kuwait has no VAT.
CREATE TABLE IF NOT EXISTS sales_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number VARCHAR(30) NOT NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined')),
  notes TEXT,
  subtotal NUMERIC(12,3) NOT NULL DEFAULT 0,
  total NUMERIC(12,3) NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales_quote_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES sales_quotes(id) ON DELETE CASCADE,
  description VARCHAR(500) NOT NULL,
  qty NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,3) NOT NULL DEFAULT 0,
  line_total NUMERIC(12,3) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sales_quotes_company ON sales_quotes(company_id);
CREATE INDEX IF NOT EXISTS idx_sales_quotes_customer ON sales_quotes(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_quote_items_quote ON sales_quote_items(quote_id);
