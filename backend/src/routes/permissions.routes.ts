import { Router } from 'express';
import { list, setForUser, myPermissions, listJobRoles, setForJobRole } from '../controllers/permissions.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

// Split into two router instances, not one, because they're mounted under DIFFERENT
// plan-tier gates in app.ts: my-permissions must work on every plan (it's read-only,
// used only for optional nav-item UX widening — a bronze company simply has zero grants
// since granting requires the gold-only admin UI below, and gets an empty array back,
// which is the safe default anyway). Managing grants (list/setForUser/job-roles) stays
// gold-only + admin-only, same restriction this router already had. Mounting them as one
// router under two different app.use(...) calls would leak the admin routes to any plan,
// since Express matches routes inside a router regardless of which mount matched first —
// splitting the router itself is the only way to keep the two gates actually separate.

// Open to any authenticated user on any plan.
export const myPermissionsRouter = Router();
myPermissionsRouter.get('/my-permissions', requireAuth, myPermissions);

// Admin-only, gold-tier only (gate applied in app.ts): granting extra access is itself a
// privileged action, kept out of reach of managers to avoid a manager delegating
// capabilities to themselves via another account.
const router = Router();
router.use(requireAuth, requireRole('admin'));
router.get('/', list);
router.put('/:userId', setForUser);
router.get('/job-roles', listJobRoles);
router.put('/job-roles/:jobRoleId', setForJobRole);

export default router;
