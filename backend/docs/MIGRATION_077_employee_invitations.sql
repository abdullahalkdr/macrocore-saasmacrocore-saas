-- MIGRATION_077_employee_invitations.sql
-- Macrocore Email System, Chat 1 — Phase 3: employee invitations.
--
-- Adds employee_invitations, the durable record behind the new invite-only
-- onboarding flow (replaces the old "create a user with a temp password"
-- experience at both entry points — company-signup colleague invites and the
-- Users page "+ New" button — per Abdullah's confirmed Phase 3 decisions,
-- 2026-09-09):
--
--   - One row per (company_id, email). Resending an invitation, or
--     re-inviting an email whose invitation expired or was revoked, UPDATEs
--     this same row in place (new token_hash, new expires_at, role/
--     full_name/preferred_language refreshed, accepted_at/revoked_at reset to
--     NULL) — this is what makes "resending invalidates every previous link"
--     (decision 6) true by construction: there is only ever one token_hash
--     value for a given (company, email) pair, so the old raw link's hash
--     simply no longer matches anything once it's overwritten.
--   - token_hash is the sha256 of a random raw token, same pattern as
--     users.password_reset_token_hash (see auth.controller.ts's
--     forgotPassword/resetPassword) — the raw token only ever exists in the
--     emailed link, never persisted.
--   - Status (Pending / Expired / Accepted / Revoked — decision 8) is derived
--     at read time from accepted_at / revoked_at / expires_at, not stored as
--     its own column — one source of truth, no risk of it drifting out of
--     sync with the timestamps that actually define it. See
--     utils/invitations.ts's deriveInvitationStatus().
--   - accepted_user_id / revoked_by are audit trail (who accepted, who
--     revoked), not used by any authorization check. invited_by/
--     accepted_user_id/revoked_by all use ON DELETE SET NULL (invited_by is
--     nullable for exactly this reason) — deleting a user who once invited,
--     accepted, or revoked an invitation must never be blocked by this
--     table; the invitation row survives as history with that reference
--     cleared — the same ON DELETE SET NULL trade-off several existing
--     created_by columns already make elsewhere in this schema.
--   - Deliberately NO uniqueness constraint spanning companies — the same
--     email can have independent invitation history in different companies.
--     Decision 11's "no conflicting active invitation elsewhere on the
--     platform" rule is an application-level check (utils/invitations.ts),
--     not a DB constraint, because it depends on runtime state (is that
--     other row still pending/unexpired right now) that a UNIQUE constraint
--     can't express.
--
-- All additive: no existing table or column is altered or dropped. Safe to
-- run against the live database with zero downtime.
--
-- Run: node scripts/run-sql.js docs/MIGRATION_077_employee_invitations.sql

CREATE TABLE IF NOT EXISTS employee_invitations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Always the lowercased/trimmed form — every write and every lookup goes
  -- through the same normalization in utils/invitations.ts, so a plain
  -- equality index (below) is enough; no functional lower(email) index needed.
  email               VARCHAR(255) NOT NULL,
  role                VARCHAR(20) NOT NULL,
  -- Hybrid name experience (decision 4): set only when the inviter typed a
  -- name; NULL means the invitee must enter their own at acceptance. Never
  -- backfilled with the email address as a placeholder.
  full_name           VARCHAR(255),
  -- Nullable (not NOT NULL) specifically so ON DELETE SET NULL below has
  -- somewhere to go — see the note above on why deleting an inviter must
  -- never be blocked by this table.
  invited_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  token_hash          VARCHAR(64) NOT NULL,
  expires_at          TIMESTAMP NOT NULL,
  accepted_at         TIMESTAMP,
  accepted_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at          TIMESTAMP,
  revoked_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Inviter's language at the moment they sent/resent this invitation
  -- (decision 3: defaults to the inviter's current interface language, not
  -- fixed at company level) — decides which language the invitation email
  -- and the accept-invitation page render in.
  preferred_language  VARCHAR(2) NOT NULL DEFAULT 'ar',
  created_at          TIMESTAMP NOT NULL DEFAULT now(),
  updated_at          TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT employee_invitations_company_email_unique UNIQUE (company_id, email),
  CONSTRAINT employee_invitations_role_check CHECK (role IN ('admin', 'manager', 'employee', 'viewer')),
  CONSTRAINT employee_invitations_preferred_language_check CHECK (preferred_language IN ('ar', 'en'))
);

-- Cross-company conflict check (decision 11): "does any OTHER company already
-- have an active invitation for this email" — scans by email across the
-- whole table, so this plain index is what keeps that check fast as the
-- table grows.
CREATE INDEX IF NOT EXISTS idx_employee_invitations_email ON employee_invitations (email);
-- Accept-invitation lookup (GET /auth/invitations/:token, POST
-- /auth/accept-invitation) hits this by token_hash only.
CREATE INDEX IF NOT EXISTS idx_employee_invitations_token_hash ON employee_invitations (token_hash);
-- The pending-invitations list (Users page) queries by company, newest first.
CREATE INDEX IF NOT EXISTS idx_employee_invitations_company_created ON employee_invitations (company_id, created_at DESC);
