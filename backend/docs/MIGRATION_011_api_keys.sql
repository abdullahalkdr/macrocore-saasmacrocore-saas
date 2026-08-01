-- macrocore.io — Migration 011 (Developer settings: API keys)
-- Additive only. Safe to run once against a database that already has
-- migrations 001-010 applied.
--
-- Keys are shown to the admin exactly once at creation time — we only ever
-- store a SHA-256 hash (fast, deterministic — appropriate for a high-entropy
-- random secret, unlike bcrypt which is for low-entropy human passwords) plus
-- a short non-secret prefix for display in the list ("mk_live_ab12••••").
-- key_hash is unique + indexed so the auth middleware can look up a request's
-- key in O(1) instead of comparing against every row.
--
-- Run it the same way you ran migration 010, e.g.:
--   node scripts/run-sql.js docs/MIGRATION_011_api_keys.sql

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  key_prefix VARCHAR(20) NOT NULL, -- e.g. "mk_live_ab12" — safe to display
  key_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256 hex digest of the full key
  created_by UUID REFERENCES users(id),
  last_used_at TIMESTAMP,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_company ON api_keys(company_id, created_at DESC);
