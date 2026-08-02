-- macrocore.io Database Schema

CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  plan VARCHAR(20) DEFAULT 'trial',
  subscription_status VARCHAR(20) DEFAULT 'trial',
  trial_start_date TIMESTAMP DEFAULT NOW(),
  trial_end_date TIMESTAMP DEFAULT NOW() + INTERVAL '14 days',
  -- Fixed monthly costs (rent, etc.) spread across estimated orders to get a true per-order overhead.
  fixed_cost_items JSONB DEFAULT '[]'::jsonb,
  estimated_orders_mode VARCHAR(10) DEFAULT 'auto',
  estimated_orders_manual INT,
  -- Default delivery-app commission %, auto-filled on employee-recorded sales (they can't override it).
  default_jahez_commission_pct DECIMAL(5, 2) DEFAULT 23,
  default_vthru_commission_pct DECIMAL(5, 2) DEFAULT 23,
  -- Attendance settings, used to compute per-minute lateness deductions.
  official_shift_start_time TIME DEFAULT '08:00:00',
  grace_period_minutes INT DEFAULT 15,
  working_days_per_month INT DEFAULT 26,
  standard_shift_minutes INT DEFAULT 480,
  -- Editable expense category labels, managed from Expenses > "إدارة الفئات"
  -- (see MIGRATION_017_expenses_location_categories.sql).
  expense_categories JSONB DEFAULT '["إيجار", "صيانة", "مشتريات مخزون", "تسويق", "فواتير"]'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL UNIQUE,
  -- Nullable: Google-only accounts (auth_provider = 'google') have no local password.
  password_hash VARCHAR(255),
  full_name VARCHAR(255),
  role VARCHAR(20) NOT NULL DEFAULT 'employee',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  -- Google OAuth (see MIGRATION_016_google_oauth.sql)
  google_id VARCHAR(255) UNIQUE,
  auth_provider VARCHAR(20) NOT NULL DEFAULT 'password',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  address VARCHAR(500),
  area VARCHAR(100),
  -- kiosk | warehouse. Inventory (raw_material_batches) is scoped per location —
  -- see stock_transfers below for how stock moves between them.
  type VARCHAR(20) DEFAULT 'kiosk',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Suppliers as a real entity (MIGRATION_021) — raw_materials.supplier_name below stays
-- as legacy free text for ad-hoc suppliers; supplier_id is the newer, optional link.
CREATE TABLE suppliers (
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

CREATE TABLE raw_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  name_en VARCHAR(255),
  category VARCHAR(50),
  package_qty DECIMAL(10, 3),
  package_unit VARCHAR(20),
  purchase_price DECIMAL(10, 3),
  supplier_name VARCHAR(255),
  supplier_id UUID REFERENCES suppliers(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Raw Material Batches (FIFO inventory tracking, scoped per location).
-- Each batch = one purchase event (or one incoming stock transfer) at ONE location.
-- qty_remaining decreases as consumed (sales, waste) via FIFO, scoped to that same location —
-- a kiosk can only consume from its own batches, never a warehouse's or another kiosk's.
-- expiry_date: optional; triggers alerts and prioritizes expired batches in FIFO order.
CREATE TABLE raw_material_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  raw_material_id UUID NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id),
  purchase_date DATE NOT NULL,
  expiry_date DATE,
  qty_purchased DECIMAL(10, 3) NOT NULL,
  qty_remaining DECIMAL(10, 3) NOT NULL,
  purchase_price DECIMAL(10, 3) NOT NULL,
  unit VARCHAR(10) NOT NULL DEFAULT 'g',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Stock transfers: moves inventory between two locations (e.g. warehouse -> kiosk).
-- Consumes FIFO from from_location_id's batches, creates ONE new batch at to_location_id.
-- new_batch_id's purchase_price = weighted-average cost of what was consumed;
-- its expiry_date is inherited from the earliest expiry among the consumed source batches.
CREATE TABLE stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  raw_material_id UUID NOT NULL REFERENCES raw_materials(id),
  from_location_id UUID NOT NULL REFERENCES locations(id),
  to_location_id UUID NOT NULL REFERENCES locations(id),
  qty DECIMAL(10, 3) NOT NULL,
  new_batch_id UUID REFERENCES raw_material_batches(id),
  transferred_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Purchase orders (MIGRATION_022) — draft -> ordered -> received, full receive only.
-- Receiving creates raw_material_batches rows automatically.
CREATE TABLE purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES suppliers(id),
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  order_date DATE,
  expected_date DATE,
  received_date DATE,
  location_id UUID REFERENCES locations(id),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  raw_material_id UUID NOT NULL REFERENCES raw_materials(id),
  qty DECIMAL(10, 3) NOT NULL,
  unit_price DECIMAL(10, 3) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  name_en VARCHAR(255),
  category VARCHAR(100),
  sell_price DECIMAL(10, 3),
  status VARCHAR(20) DEFAULT 'active',
  -- true = sold as size variants (see product_sizes) instead of one flat sell_price.
  has_sizes BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE product_ingredients (
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  raw_material_id UUID NOT NULL REFERENCES raw_materials(id),
  usage_qty DECIMAL(10, 3),
  usage_unit VARCHAR(20),
  is_packaging BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (product_id, raw_material_id)
);

-- Size variants (S/M/L, etc.) for products with has_sizes = true. Each size has its
-- own price and its own recipe (product_size_ingredients) — a Large uses more of an
-- ingredient than a Small, not just a price multiplier.
CREATE TABLE product_sizes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  name_en VARCHAR(100),
  sell_price DECIMAL(10, 3),
  sort_order INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE product_size_ingredients (
  product_size_id UUID NOT NULL REFERENCES product_sizes(id) ON DELETE CASCADE,
  raw_material_id UUID NOT NULL REFERENCES raw_materials(id),
  usage_qty DECIMAL(10, 3),
  usage_unit VARCHAR(20),
  is_packaging BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (product_size_id, raw_material_id)
);

CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(20),
  job_role VARCHAR(100),
  salary_monthly DECIMAL(10, 3),
  start_date DATE,
  status VARCHAR(20) DEFAULT 'active',
  -- Extended HR profile
  photo_base64 TEXT,
  civil_id VARCHAR(30),
  birth_date DATE,
  weight_kg DECIMAL(5, 2),
  prior_experience TEXT,
  certificates JSONB DEFAULT '[]'::jsonb,
  -- Wage structure: 'monthly' uses salary_monthly as-is; 'hourly' uses hourly_rate *
  -- hours actually worked (computed from attendance_records at payroll generation time).
  wage_type VARCHAR(10) DEFAULT 'monthly', -- monthly | hourly
  hourly_rate DECIMAL(10, 3),
  -- HR/compliance fields (MIGRATION_013) — expat-heavy Kuwait kiosk workforce.
  nationality VARCHAR(100),
  civil_id_expiry DATE,
  residency_number VARCHAR(50),
  residency_expiry DATE,
  passport_number VARCHAR(50),
  passport_expiry DATE,
  bank_iban VARCHAR(50),
  emergency_contact_name VARCHAR(150),
  emergency_contact_phone VARCHAR(30),
  -- Home/assigned location, itemized monthly allowances (summed into payroll base pay
  -- at generation time), and shift-start/grace-period pair for a future automatic
  -- late-deduction feature (MIGRATION_019).
  location_id UUID REFERENCES locations(id),
  allowances JSONB DEFAULT '[]'::jsonb,
  shift_start_time TIME,
  late_grace_minutes INT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- One row per employee per day. late_minutes/deduction_amount computed at clock-in
-- from the company's attendance settings above.
CREATE TABLE attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  clock_in TIMESTAMP,
  clock_out TIMESTAMP,
  late_minutes INT DEFAULT 0,
  deduction_amount DECIMAL(10, 3) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'present',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (employee_id, date)
);

CREATE TABLE leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  start_time TIME,
  end_time TIME,
  reason TEXT,
  attachment_base64 TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMP,
  -- Manager-only note, set/edited alongside status (see MIGRATION_018).
  manager_note TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES employees(id),
  location_id UUID REFERENCES locations(id),
  date DATE NOT NULL,
  opened_at TIMESTAMP,
  closed_at TIMESTAMP,
  status VARCHAR(20) DEFAULT 'open',
  closing_notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Advance roster/planning (MIGRATION_020) — separate from the live shifts table above,
-- purely "who's expected to work which date/location". Doesn't touch the POS flow.
CREATE TABLE shift_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id),
  date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE shift_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  product_size_id UUID REFERENCES product_sizes(id),
  assigned_qty DECIMAL(10, 3),
  remaining_qty DECIMAL(10, 3),
  actual_remaining_qty DECIMAL(10, 3),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shift_id UUID NOT NULL REFERENCES shifts(id),
  product_id UUID NOT NULL REFERENCES products(id),
  product_size_id UUID REFERENCES product_sizes(id),
  qty DECIMAL(10, 3) NOT NULL,
  unit_price DECIMAL(10, 3),
  total_price DECIMAL(10, 3),
  payment_method VARCHAR(20),
  app_commission_pct DECIMAL(5, 2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  version INT DEFAULT 1
);

CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category VARCHAR(100),
  amount DECIMAL(10, 3),
  description VARCHAR(500),
  receipt_image TEXT,
  -- Which kiosk/warehouse this was spent at (nullable — older rows and
  -- company-wide expenses have no single location).
  location_id UUID REFERENCES locations(id),
  -- Backdatable spend date, separate from created_at (when the row was entered).
  expense_date DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by UUID REFERENCES users(id)
);

CREATE TABLE waste_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shift_id UUID NOT NULL REFERENCES shifts(id),
  product_id UUID NOT NULL REFERENCES products(id),
  qty DECIMAL(10, 3),
  image_base64 TEXT,
  cost_of_goods DECIMAL(10, 3),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE cash_denominations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shift_id UUID NOT NULL REFERENCES shifts(id),
  denomination DECIMAL(10, 3),
  count INT,
  total DECIMAL(10, 3),
  created_at TIMESTAMP DEFAULT NOW()
);

-- base_salary/wage_type/hourly_rate are all snapshotted at generation time — a later
-- raise or wage_type change never retroactively alters an already-generated payslip.
-- For wage_type = 'hourly', base_salary = hours_worked * hourly_rate (computed once,
-- at generation time). attendance_deduction is auto-pulled from attendance_records
-- (SUM of deduction_amount across the month) — see payroll_adjustments below for
-- itemized manual bonuses/deductions on top of it.
CREATE TABLE payroll (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id),
  month_year VARCHAR(7),
  base_salary DECIMAL(10, 3),
  attendance_bonus DECIMAL(10, 3) DEFAULT 0,
  other_deductions DECIMAL(10, 3) DEFAULT 0,
  wage_type VARCHAR(10) DEFAULT 'monthly',
  hourly_rate DECIMAL(10, 3),
  hours_worked DECIMAL(10, 2),
  attendance_deduction DECIMAL(10, 3) DEFAULT 0,
  total_paid DECIMAL(10, 3),
  status VARCHAR(20) DEFAULT 'pending',
  paid_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Itemized manual bonuses/deductions on a payroll record (e.g. "عيدية" +50,
-- "غرامة معدات" -10) — a real line-item breakdown instead of one flat number.
CREATE TABLE payroll_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_id UUID NOT NULL REFERENCES payroll(id) ON DELETE CASCADE,
  type VARCHAR(10) NOT NULL, -- bonus | deduction
  label VARCHAR(255) NOT NULL,
  amount DECIMAL(10, 3) NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Company-issued correspondence generator: official letters, salary/experience
-- certificates, receipts. reference_number is auto-assigned "COR-{year}-{seq}",
-- sequential per company per year (see src/utils/officialDocuments.ts).
CREATE TABLE official_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reference_number VARCHAR(50) NOT NULL,
  doc_type VARCHAR(30) NOT NULL,
  title VARCHAR(255) NOT NULL,
  addressed_to_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  addressed_to_name VARCHAR(255),
  document_date DATE NOT NULL,
  body TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (company_id, reference_number)
);

-- Files the company HOLDS (licenses, lease contracts, permits, certificates) — upload
-- and store, with an optional expiry_date for renewal alerts. Distinct from
-- official_documents above, which generates outgoing correspondence instead of storing
-- existing files. Same base64-in-JSON storage pattern as waste_records.image_base64
-- and employees.certificates (no object storage wired up yet).
CREATE TABLE company_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(30) NOT NULL DEFAULT 'other',
  file_base64 TEXT,
  file_name VARCHAR(255),
  issue_date DATE,
  expiry_date DATE,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  subject VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'open',
  priority VARCHAR(20) DEFAULT 'medium',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE ticket_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  is_admin_reply BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  action VARCHAR(50),
  entity_type VARCHAR(50),
  entity_id UUID,
  old_values JSONB,
  new_values JSONB,
  ip_address VARCHAR(50),
  user_agent VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE version_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name VARCHAR(50) NOT NULL,
  record_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version INT NOT NULL,
  old_values JSONB,
  new_values JSONB,
  changed_by UUID REFERENCES users(id),
  changed_at TIMESTAMP DEFAULT NOW(),
  reason VARCHAR(255)
);

CREATE TABLE sync_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  device_id VARCHAR(255),
  last_sync_timestamp TIMESTAMP,
  last_synced_version INT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE conflict_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  table_name VARCHAR(50),
  record_id UUID,
  server_version JSONB,
  client_version JSONB,
  resolution VARCHAR(50),
  resolved_by UUID,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan VARCHAR(20) NOT NULL,
  status VARCHAR(20) DEFAULT 'active',
  monthly_price DECIMAL(10, 3),
  auto_renew BOOLEAN DEFAULT true,
  next_billing_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id),
  amount DECIMAL(10, 3),
  status VARCHAR(20) DEFAULT 'pending',
  issue_date TIMESTAMP,
  due_date TIMESTAMP,
  payment_date TIMESTAMP,
  telr_transaction_id VARCHAR(255),
  pdf_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  last_used_at TIMESTAMP,
  status VARCHAR(20) DEFAULT 'active',
  UNIQUE (key_hash)
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT,
  link VARCHAR(255),
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE customers (
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

CREATE TABLE user_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, permission_key)
);

CREATE INDEX idx_users_company ON users(company_id);
CREATE INDEX idx_sales_company_date ON sales(company_id, created_at DESC);
CREATE INDEX idx_sales_shift ON sales(shift_id);
CREATE INDEX idx_shifts_company_date ON shifts(company_id, date DESC);
CREATE INDEX idx_employees_company ON employees(company_id);
CREATE INDEX idx_audit_logs_company ON audit_logs(company_id, created_at DESC);
CREATE INDEX idx_version_history_record ON version_history(table_name, record_id);
CREATE INDEX idx_tickets_company ON support_tickets(company_id, created_at DESC);
CREATE INDEX idx_invoices_company ON invoices(company_id, created_at DESC);
CREATE INDEX idx_raw_material_batches_company ON raw_material_batches(company_id);
CREATE INDEX idx_raw_material_batches_material ON raw_material_batches(raw_material_id, qty_remaining DESC);
CREATE INDEX idx_raw_material_batches_expiry ON raw_material_batches(expiry_date);
CREATE INDEX idx_raw_material_batches_location ON raw_material_batches(company_id, location_id, raw_material_id, qty_remaining DESC);
CREATE INDEX idx_stock_transfers_company ON stock_transfers(company_id, created_at DESC);
CREATE INDEX idx_stock_transfers_material ON stock_transfers(raw_material_id);
CREATE INDEX idx_payroll_adjustments_payroll ON payroll_adjustments(payroll_id);
CREATE INDEX idx_official_documents_company ON official_documents(company_id, created_at DESC);
CREATE INDEX idx_company_files_company ON company_files(company_id, created_at DESC);
CREATE INDEX idx_shift_schedules_company_date ON shift_schedules(company_id, date);
CREATE INDEX idx_shift_schedules_employee ON shift_schedules(employee_id, date);
CREATE INDEX idx_purchase_orders_company ON purchase_orders(company_id, created_at DESC);
CREATE INDEX idx_purchase_order_items_po ON purchase_order_items(purchase_order_id);
CREATE INDEX idx_company_files_expiry ON company_files(expiry_date);
CREATE INDEX idx_user_permissions_user ON user_permissions(user_id);
CREATE INDEX idx_user_permissions_company ON user_permissions(company_id);
CREATE INDEX idx_customers_company ON customers(company_id);
CREATE INDEX idx_customers_phone ON customers(company_id, phone);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;