import { Router } from 'express';
import { list, markRead, markAllRead } from '../controllers/notifications.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/read-all', markAllRead);
router.post('/:id/read', markRead);

export default router;
