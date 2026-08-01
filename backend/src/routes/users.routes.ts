import { Router } from 'express';
import { list, create, update, remove, getMe, updateMe } from '../controllers/users.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
// /me routes must be registered before /:id so "me" isn't swallowed as an id param.
router.get('/me', getMe);
router.patch('/me', updateMe);
router.get('/', list);
router.post('/', requireRole('admin', 'manager'), create);
router.patch('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', requireRole('admin'), remove);

export default router;
