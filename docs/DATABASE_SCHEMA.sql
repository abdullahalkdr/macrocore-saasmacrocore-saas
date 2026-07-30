-- macrocore.io Database Schema
-- PostgreSQL
-- Run via: npm run db:migrate  (backend/scripts/migrate.js)

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() on PG < 13

-- ===== AUTHENTICATION & MULTI-TENANCY =====

CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  plan VARCHAR(20) DEFAULT 'trial', -- 'trial', 'bronze', 'silver', 'gold'
  subscription_status VARCHAR(20) DEFAULT 'trial', -- 'trial', 'active', 'suspended', 'cancelled'
  trial_start_date TIMESTAMP DEFAULT NOW(),
  trial_end_date TIMESTAMP DEFAULT NOW() + INTERVAL '14 days',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255),
  role VARCHAR(20) NOT NULL DEFAULT 'employee', -- 'admin', 'manager', 'employee', 'viewer'
  status VARCHAR(20) NOT NULL DEFAULT 'active', -- 'active', 'suspended', 'inactive'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ===== BUSINESS DATA =====

CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  address VARCHAR(500),
  area VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE raw_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(50),
  package_qty DECIMAL(10, 3),
  package_unit VARCHAR(20),
  purchase_price DECIMAL(10, 3),
  supplier_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100),
  sell_price DECIMAL(10, 3),
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE product_ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  raw_material_id UUID NOT NULL REFERENCES raw_materials(id),
  usage_qty DECIMAL(10, 3),
  usage_unit VARCHAR(20),
  UNIQUE (product_id, raw_material_id)
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
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE shift_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  assigned_qty DECIMAL(10, 3),
  remaining_qty DECIMAL(10, 3),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shift_id UUID NOT NULL REFERENCES shifts(id),
  product_id UUID NOT NULL REFERENCES products(id),
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

CREATE TABLE payroll (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id),
  month_year VARCHAR(7),
  base_salary DECIMAL(10, 3),
  attendance_bonus DECIMAL(10, 3) DEFAULT 0,
  other_deductions DECIMAL(10, 3) DEFAULT 0,
  total_paid DECIMAL(10, 3),
  status VARCHAR(20) DEFAULT 'pending',
  paid_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ===== SUPPORT & TICKETS =====

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

-- ===== AUDIT & HISTORY =====

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

-- ===== SYNC & OFFLINE =====

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

-- ===== BILLING & SUBSCRIPTIONS =====

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

-- ===== INDEXES (Performance) =====

CREATE INDEX idx_users_company ON users(company_id);
CREATE INDEX idx_sales_company_date ON sales(company_id, created_at DESC);
CREATE INDEX idx_sales_shift ON sales(shift_id);
CREATE INDEX idx_shifts_company_date ON shifts(company_id, date DESC);
CREATE INDEX idx_employees_company ON employees(company_id);
CREATE INDEX idx_audit_logs_company ON audit_logs(company_id, created_at DESC);
CREATE INDEX idx_version_history_record ON version_history(table_name, record_id);
CREATE INDEX idx_tickets_company ON support_tickets(company_id, created_at DESC);
CREATE INDEX idx_invoices_company ON invoices(company_id, created_at DESC);
