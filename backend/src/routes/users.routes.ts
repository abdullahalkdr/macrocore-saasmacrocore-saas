import { Router } from 'express';
import { list, update, remove, getMe, updateMe } from '../controllers/users.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
// /me routes must be registered before /:id so "me" isn't swallowed as an id param.
router.get('/me', getMe);
router.patch('/me', updateMe);
router.get('/', list);
// POST / (create a user directly with a temp password) is gone — adding a
// teammate now goes through POST /api/invitations (see
// invitations.routes.ts), both from this Users page and from company
// signup. See users.controller.ts's removed create() for the full note.
router.patch('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', requireRole('admin'), remove);

export default router;
