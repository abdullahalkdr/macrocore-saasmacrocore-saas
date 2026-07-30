-- macrocore.io — Migration 008 (Official document generator: letters, salary
-- certificates, receipts — auto reference numbers, printable)
-- Additive only — does not touch existing columns or data. Safe to run once
-- against the same database MIGRATION_007_advanced_payroll.sql was already applied to.
--
-- Run it the same way you ran migration 007, e.g.:
--   psql "$DATABASE_URL" -f docs/MIGRATION_008_official_documents.sql

-- Company-issued correspondence: official letters, salary/experience certificates,
-- receipts — anything issued in the company's name that needs a traceable reference
-- number. Distinct from the earlier-considered "company documents" idea (licenses/
-- contracts the company holds, with expiry alerts) — this module instead GENERATES
-- outgoing documents with content typed in and printed/exported, not uploads of
-- existing files. reference_number is auto-assigned at creation (see
-- src/utils/officialDocuments.ts), formatted "COR-{year}-{seq}", sequential per
-- company per year.
CREATE TABLE IF NOT EXISTS official_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reference_number VARCHAR(50) NOT NULL,
  doc_type VARCHAR(30) NOT NULL, -- letter | salary_certificate | experience_certificate | receipt | other
  title VARCHAR(255) NOT NULL,
  -- Addressed to either an employee on file, or a free-text external entity/person —
  -- exactly one of these two is expected to be set (enforced in the controller, not a
  -- DB constraint, to keep this additive-only migration simple).
  addressed_to_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  addressed_to_name VARCHAR(255),
  document_date DATE NOT NULL,
  body TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (company_id, reference_number)
);
CREATE INDEX IF NOT EXISTS idx_official_documents_company ON official_documents(company_id, created_at DESC);
