import { Router } from 'express';
import { create, list, updateStatus, calendar } from '../controllers/leaveRequests.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.get('/calendar', calendar);
router.post('/', create);
router.patch('/:id', requireRole('admin', 'manager'), updateStatus);

export default router;
