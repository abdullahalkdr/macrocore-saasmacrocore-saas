-- Grandfather every company that existed before subscription enforcement shipped.
-- Enforcement (see backend/src/middleware/subscription.ts) blocks access once
-- plan='trial' AND trial_end_date has passed, or subscription_status is anything
-- other than 'trial'/'active'. Companies created during earlier development
-- (CornLab included) have trial_end_date values from whenever their row was
-- inserted, which by now is almost certainly in the past — without this
-- backfill, turning enforcement on would immediately lock out every existing
-- tenant, including the one actually running a kiosk on this system today.
-- New signups going forward are unaffected — they still start on plan='trial'
-- with a real 14-day window (see backend/src/controllers/auth.controller.ts).
UPDATE companies
SET subscription_status = 'active'
WHERE subscription_status = 'trial';
