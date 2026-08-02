import { Router } from 'express';
import { list, setForUser } from '../controllers/permissions.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

// Admin-only: granting extra access is itself a privileged action, kept out of
// reach of managers to avoid a manager delegating capabilities to themselves via
// another account.
router.use(requireAuth, requireRole('admin'));
router.get('/', list);
router.put('/:userId', setForUser);

export default router;
