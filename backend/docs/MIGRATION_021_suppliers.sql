-- Suppliers as a real entity (contact info, notes) instead of just a free-text
-- name on raw_materials. supplier_name stays as-is (legacy free text, still usable
-- for ad-hoc suppliers not worth a full record) — supplier_id is additive, optional.
CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  contact_name VARCHAR(255),
  phone VARCHAR(20),
  email VARCHAR(255),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE raw_materials
  ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id);

CREATE INDEX IF NOT EXISTS idx_suppliers_company ON suppliers(company_id);
