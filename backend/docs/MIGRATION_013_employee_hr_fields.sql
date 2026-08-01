-- Expands the employee HR file: nationality, residency/civil ID/passport
-- expiry tracking (common compliance need for expat staff in Kuwait), join
-- date (start_date already existed but was never exposed in the app), bank
-- IBAN for payroll transfer reference, and an emergency contact.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS nationality VARCHAR(100),
  ADD COLUMN IF NOT EXISTS civil_id_expiry DATE,
  ADD COLUMN IF NOT EXISTS residency_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS residency_expiry DATE,
  ADD COLUMN IF NOT EXISTS passport_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS passport_expiry DATE,
  ADD COLUMN IF NOT EXISTS bank_iban VARCHAR(50),
  ADD COLUMN IF NOT EXISTS emergency_contact_name VARCHAR(150),
  ADD COLUMN IF NOT EXISTS emergency_contact_phone VARCHAR(30);
