-- MIGRATION_016_google_oauth.sql
-- Adds "Sign in / Sign up with Google" support.
--   - password_hash becomes nullable: Google-only accounts never get a local password.
--   - google_id links a user row to their Google account (unique per account).
--   - auth_provider tracks how the account authenticates ('password' | 'google').
-- Safe to re-run: DROP NOT NULL no-ops if already nullable, ADD COLUMN IF NOT EXISTS is idempotent.

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) NOT NULL DEFAULT 'password';
