-- MIGRATION_018_leave_request_manager_note.sql
-- Adds a manager-only note field, shown/edited alongside status when a manager
-- reviews or edits a leave/permission request (Leave Requests > edit modal).

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS manager_note TEXT;
