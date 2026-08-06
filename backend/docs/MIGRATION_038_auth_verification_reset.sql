-- Email verification + forgot/reset password. Additive-only, safe to re-run.
-- Run with: node scripts/run-sql.js docs/MIGRATION_038_auth_verification_reset.sql

-- NULL = not verified yet. Google accounts get this set at signup (Google already
-- verified the mailbox); password accounts get it set when they click the emailed link.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP;

-- Password reset uses an opaque random token (not a JWT) so it can be invalidated
-- server-side after one use or on expiry — only the SHA-256 hash is stored, the raw
-- token only ever exists in the emailed link, never touches the database or logs.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMP;

-- Backfill: don't retroactively lock existing accounts out over a feature that didn't
-- exist when they signed up. Only new signups from here on go through real verification.
UPDATE users SET email_verified_at = NOW() WHERE email_verified_at IS NULL;
