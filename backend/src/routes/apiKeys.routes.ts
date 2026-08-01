import { Router } from 'express';
import { list, create, revoke } from '../controllers/apiKeys.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth, requireRole('admin'));
router.get('/', list);
router.post('/', create);
router.delete('/:id', revoke);

export default router;
