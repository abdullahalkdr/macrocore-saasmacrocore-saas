-- Basic customer directory + loyalty points. Deliberately NOT wired into the live
-- sales/POS transaction path (createSaleTx in salesService.ts) to avoid any risk to
-- that flow — points are awarded/adjusted manually by staff via a dedicated endpoint
-- (see customers.controller.ts adjustPoints()), same spirit as the shift_schedules
-- table being kept separate from the live `shifts` table.
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(255),
  points INT NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_company ON customers(company_id);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(company_id, phone);
