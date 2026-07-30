-- macrocore.io — Migration 009 (Company files: licenses/contracts/certificates the
-- company HOLDS — upload, store, expiry alerts)
-- Additive only — does not touch existing columns or data. Safe to run once
-- against the same database MIGRATION_008_official_documents.sql was already applied to.
--
-- Distinct from official_documents (Migration 008), which GENERATES outgoing letters/
-- certificates typed in by the user. This module instead stores files the company
-- already holds — a commercial license, a lease contract, a municipality permit — as
-- an upload, same base64-in-JSON pattern as waste_records.image_base64 and
-- employees.certificates elsewhere in this schema (no object storage wired up yet).
--
-- Run it the same way you ran migration 008, e.g.:
--   psql "$DATABASE_URL" -f docs/MIGRATION_009_company_files.sql

CREATE TABLE IF NOT EXISTS company_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(30) NOT NULL DEFAULT 'other', -- license | contract | certificate | other
  file_base64 TEXT,
  file_name VARCHAR(255), -- original filename, since base64 alone doesn't show file type/name
  issue_date DATE,
  expiry_date DATE, -- NULL = never expires (e.g. some contracts/certificates)
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_company_files_company ON company_files(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_files_expiry ON company_files(expiry_date);
