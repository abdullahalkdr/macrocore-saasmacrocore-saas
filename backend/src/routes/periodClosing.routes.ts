import { Router } from 'express';
import { list, closePeriod, reopenPeriod } from '../controllers/periodClosing.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/', requireRole('admin', 'manager'), closePeriod);
router.delete('/:id', requireRole('admin', 'manager'), reopenPeriod);

export default router;
