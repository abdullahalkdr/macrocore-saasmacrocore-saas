-- Purchase orders: a formal "we ordered X from supplier Y" record, replacing the
-- old flow of just typing a purchase straight into raw_material_batches. Kept simple
-- on purpose (draft -> ordered -> received, full receive only, no partial lines) —
-- receiving a PO creates the raw_material_batches rows automatically (see
-- purchaseOrders.controller.ts's receive()), same batch shape a manual batch entry
-- already produces.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES suppliers(id),
  status VARCHAR(20) NOT NULL DEFAULT 'draft', -- draft | ordered | received | cancelled
  order_date DATE,
  expected_date DATE,
  received_date DATE,
  location_id UUID REFERENCES locations(id),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  raw_material_id UUID NOT NULL REFERENCES raw_materials(id),
  qty DECIMAL(10, 3) NOT NULL,
  unit_price DECIMAL(10, 3) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_company ON purchase_orders(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po ON purchase_order_items(purchase_order_id);
