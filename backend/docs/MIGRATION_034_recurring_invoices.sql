-- "فواتير مجدولة" (Recurring Invoices) — a template (customer + items + frequency),
-- not a background cron job (macrocore has no job runner). generateNow() in
-- recurringInvoices.controller.ts creates one real sales_invoices row from the
-- template on demand and advances next_run_date, so staff stay in control of when an
-- invoice actually goes out rather than it silently firing unattended.
CREATE TABLE IF NOT EXISTS recurring_invoice_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  frequency VARCHAR(10) NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly', 'monthly')),
  next_run_date DATE NOT NULL DEFAULT CURRENT_DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recurring_invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES recurring_invoice_templates(id) ON DELETE CASCADE,
  description VARCHAR(500) NOT NULL,
  qty NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,3) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_recurring_invoice_templates_company ON recurring_invoice_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_recurring_invoice_items_template ON recurring_invoice_items(template_id);
