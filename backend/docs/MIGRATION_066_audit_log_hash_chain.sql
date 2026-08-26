-- MIGRATION_066_audit_log_hash_chain.sql
--
-- Phase 01 "hash chaining" from the Activity Log roadmap. Abdullah's locked scope
-- decision: one independent hash chain PER COMPANY (not one global chain across the
-- whole system) — cheaper, and matches every other per-tenant boundary already in
-- this schema (retention, archiving, deletion cascades all key off company_id too).
--
-- What a hash chain buys you on top of MIGRATION_064's append-only trigger: the
-- trigger stops anyone from UPDATE/DELETE-ing a row through normal SQL, but it can't
-- prove nothing was tampered with via an out-of-band path (a restored backup with one
-- row quietly edited, a direct superuser session, etc.). Each row's `hash` commits to
-- its own content AND to the previous row's hash (`prev_hash`) — change or remove
-- ANY row in the middle of the chain and every hash after it stops matching, which a
-- verification pass (backend/scripts/verify-audit-chain.js, added alongside this
-- migration) will catch immediately.
--
-- Deliberately NOT backfilled for existing rows — and this is a real decision, not
-- laziness: computing a hash from a row's CURRENT stored values today doesn't prove
-- that row was never altered in the past. A fabricated "chain" over historical data
-- would just bless whatever the data happens to look like right now — false
-- confidence, not real integrity. So prev_hash/hash start out NULL on every row that
-- already exists, and the chain genuinely starts protecting data from the moment this
-- migration runs forward. Existing rows keep exactly the protection MIGRATION_064
-- already gives them (append-only) — they just predate the hash chain. This is
-- disclosed here and in verify-audit-chain.js's own output, not hidden.
--
-- Continuity across retention/archiving (MIGRATION_065): a company's chain must keep
-- extending correctly even after its oldest rows move to audit_logs_archive. Handled
-- for free by the trigger below always looking at audit_logs first and only falling
-- back to audit_logs_archive if the live table has nothing left for that company (a
-- company dormant for over 12 months, then active again) — no special-casing needed
-- beyond that fallback query, since audit_logs_archive.hash/prev_hash are carried
-- over unchanged from the live table by the archiving script (updated alongside this
-- migration to also copy those two columns).
--
-- Concurrency: two simultaneous requests for the same company could otherwise both
-- read the same "current tip" and each think they're extending the chain from the
-- same point (a fork, silently breaking verification later). A per-company advisory
-- transaction lock (pg_advisory_xact_lock) serializes concurrent inserts for the same
-- company_id, held until the inserting transaction commits — cheap, and only ever
-- contends with another insert for the SAME company at the SAME instant.
--
-- Hashing uses Postgres's built-in sha256() (core since PG 11) — no extension
-- (pgcrypto etc.) needed, matches this schema's existing choice of gen_random_uuid()
-- also being core-only.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_066_audit_log_hash_chain.sql

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS hash VARCHAR(64);

ALTER TABLE audit_logs_archive ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64);
ALTER TABLE audit_logs_archive ADD COLUMN IF NOT EXISTS hash VARCHAR(64);

-- Lets the archive-fallback lookup (and any future per-company query against the
-- archive) avoid a full scan as it grows — same shape as MIGRATION_064's index on
-- the live table.
CREATE INDEX IF NOT EXISTS idx_audit_logs_archive_company_created
  ON audit_logs_archive (company_id, created_at DESC);

CREATE OR REPLACE FUNCTION audit_logs_compute_hash()
RETURNS TRIGGER AS $$
DECLARE
  v_prev_hash VARCHAR(64);
BEGIN
  -- Serialize concurrent inserts for the same company for the rest of this
  -- transaction — see header comment above.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.company_id::text)::bigint);

  SELECT hash INTO v_prev_hash FROM audit_logs
    WHERE company_id = NEW.company_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

  IF v_prev_hash IS NULL THEN
    -- Nothing left in the live table for this company (either its first-ever row,
    -- or everything of theirs has already been archived) — fall back to the
    -- archive's tip so the chain keeps extending instead of silently restarting.
    SELECT hash INTO v_prev_hash FROM audit_logs_archive
      WHERE company_id = NEW.company_id
      ORDER BY created_at DESC, id DESC
      LIMIT 1;
  END IF;

  NEW.prev_hash := v_prev_hash;
  NEW.hash := encode(
    sha256(
      convert_to(
        COALESCE(v_prev_hash, '') || '|' ||
        NEW.id::text || '|' ||
        NEW.company_id::text || '|' ||
        COALESCE(NEW.user_id::text, '') || '|' ||
        COALESCE(NEW.action, '') || '|' ||
        COALESCE(NEW.entity_type, '') || '|' ||
        COALESCE(NEW.entity_id::text, '') || '|' ||
        COALESCE(NEW.created_at::text, ''),
        'UTF8'
      )
    ),
    'hex'
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_hash_chain ON audit_logs;
CREATE TRIGGER audit_logs_hash_chain
  BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_compute_hash();
