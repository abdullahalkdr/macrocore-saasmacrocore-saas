import { Router } from 'express';
import { list, create, resend, revoke } from '../controllers/invitations.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
// Decision 8: pending invitations are visible only to authorized inviters —
// same admin/manager boundary as everything else in this flow. Fine-grained
// role-vs-invited-role enforcement (a manager can't touch an admin/manager
// invitation) happens inside the controller via assertInvitableRole.
router.use(requireRole('admin', 'manager'));
router.get('/', list);
router.post('/', create);
router.post('/:id/resend', resend);
router.post('/:id/revoke', revoke);

export default router;
