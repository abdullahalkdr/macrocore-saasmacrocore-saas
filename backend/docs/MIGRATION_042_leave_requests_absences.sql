-- MIGRATION_042_leave_requests_absences.sql
-- "Absences" restructuring: Leave & Permissions -> Absences, split into two
-- sub-sections (Leave / Absence Permission). Adds:
--   category            'leave' | 'absence_permission' — which sub-section a row
--                        belongs to. Existing rows are backfilled below (old
--                        type='permission' rows -> 'absence_permission', everything
--                        else stays the default 'leave').
--   permission_reason   structured (السبب) dropdown, used only when
--                        category='absence_permission'. Kept as a NEW column,
--                        separate from the existing freeform `reason` TEXT column —
--                        `reason` is untouched and keeps holding old permission
--                        rows' freeform text as-is (product decision, not migrated).
--   notice_received_by  new field, used only when category='absence_permission'.
--
-- `type` VARCHAR(20) is reused as-is: for category='leave' it now holds one of the
-- 8 new leave-type slugs (azaa_leave, annual_leave, covid_19, hajj_leave,
-- marriage_leave, paternity_leave, sick_leave, study_leave — all <=20 chars, no
-- column-width change needed); for category='absence_permission' it stays fixed
-- at 'permission' (unchanged from before).

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS category VARCHAR(20) NOT NULL DEFAULT 'leave';
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS permission_reason VARCHAR(30);
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS notice_received_by VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_leave_requests_category ON leave_requests(category);

-- Backfill: existing 'permission' rows belong to the new Absence Permission sub-section.
UPDATE leave_requests SET category = 'absence_permission' WHERE type = 'permission';
