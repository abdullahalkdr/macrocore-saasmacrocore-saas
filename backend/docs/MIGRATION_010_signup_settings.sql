-- macrocore.io — Migration 010 (Signup wizard fields + Settings module)
-- Additive only — does not touch existing columns or data. Safe to run once
-- against a database that already has migrations 001-009 applied.
--
-- Adds the fields needed for: (1) the multi-step signup wizard (name split,
-- job title, phone, company industry/size/country), and (2) the Settings
-- pages (company address/tax/branding fields, feature-toggle preferences).
--
-- Run it the same way you ran migration 009, e.g.:
--   node scripts/run-sql.js docs/MIGRATION_010_signup_settings.sql

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS last_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS job_title VARCHAR(100), -- "ما هو الوصف الأنسب لك؟" from signup step 2
  ADD COLUMN IF NOT EXISTS phone VARCHAR(30);

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS industry VARCHAR(100),
  ADD COLUMN IF NOT EXISTS employee_count_range VARCHAR(20),
  ADD COLUMN IF NOT EXISTS country VARCHAR(2) DEFAULT 'KW',
  -- Address (all optional — matches Wafeq-style company settings form, mostly unused by
  -- macrocore's own product logic today, just stored/displayed).
  ADD COLUMN IF NOT EXISTS street VARCHAR(255),
  ADD COLUMN IF NOT EXISTS building_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS district VARCHAR(100),
  ADD COLUMN IF NOT EXISTS city VARCHAR(100),
  ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS commercial_registration_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS tax_registration_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS fiscal_year_end_month INT DEFAULT 12, -- 1-12
  ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(30),
  -- Branding — same base64-in-column pattern as company_files.file_base64 (no object
  -- storage wired up yet).
  ADD COLUMN IF NOT EXISTS logo_base64 TEXT,
  ADD COLUMN IF NOT EXISTS stamp_base64 TEXT,
  -- Feature-toggle preferences shown in Company Settings > Preferences. Only toggles that
  -- map to a real macrocore capability — no "auto revaluation"/accounting-style toggle,
  -- since that concept doesn't exist in this product.
  ADD COLUMN IF NOT EXISTS inventory_enabled BOOLEAN DEFAULT true, -- hides raw-material/FIFO nav for companies that don't need it
  ADD COLUMN IF NOT EXISTS delivery_notifications_enabled BOOLEAN DEFAULT true, -- jahez/vthru alerts
  ADD COLUMN IF NOT EXISTS two_factor_required BOOLEAN DEFAULT false; -- stored now; enforcement lands once an OTP provider is wired up
