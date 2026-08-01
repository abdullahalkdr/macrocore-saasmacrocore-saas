-- macrocore.io — Migration 012 (Customizations: custom fields + document templates)
-- Additive only. Safe to run once against a database that already has
-- migrations 001-011 applied.
--
-- custom_fields: lets an admin define extra named fields to attach to
-- documents/records later (definitions only for now — no UI yet applies them
-- to a specific entity's data, this just lets Settings > Customizations
-- list/create/delete the definitions).
--
-- document_templates: a single row per company (is_default always true today —
-- multiple named templates can come later) holding the branding config applied
-- when generating official documents/PDFs: logo, primary color, footer text,
-- whether to show the company stamp.
--
-- Run it the same way you ran migration 011, e.g.:
--   node scripts/run-sql.js docs/MIGRATION_012_customizations.sql

CREATE TABLE IF NOT EXISTS custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  field_type VARCHAR(20) NOT NULL DEFAULT 'text', -- text | number | date | yes_no
  applies_to VARCHAR(30) NOT NULL DEFAULT 'official_documents', -- official_documents | company_files | employees
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_custom_fields_company ON custom_fields(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS document_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL DEFAULT 'الافتراضي',
  is_default BOOLEAN DEFAULT true,
  logo_base64 TEXT,
  primary_color VARCHAR(9) DEFAULT '#f59e0b',
  footer_text TEXT,
  show_stamp BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_templates_company_default
  ON document_templates(company_id) WHERE is_default = true;
