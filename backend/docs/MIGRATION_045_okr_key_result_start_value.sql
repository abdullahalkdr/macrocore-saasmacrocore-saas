-- MIGRATION_045_okr_key_result_start_value.sql
--
-- OKR correctness fix: progress on a Key Result cannot be measured from
-- target_value alone (that implicitly assumes the starting point is 0,
-- which is wrong for things like "raise CSAT from 75% to 90%"). Adds an
-- explicit baseline column so the KR carries where it started, not just
-- where it's headed.
--
-- Run manually against the database (no automatic migration runner in this
-- project — see backend/scripts/migrate.js's own comment). Safe to re-run.

ALTER TABLE okr_key_results ADD COLUMN IF NOT EXISTS start_value DECIMAL(14, 3) DEFAULT 0;
