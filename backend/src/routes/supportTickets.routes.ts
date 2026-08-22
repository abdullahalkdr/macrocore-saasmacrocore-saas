import { Router } from 'express';
import { list, create, getOne, reply, updateStatus, slaReport } from '../controllers/supportTickets.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/sla-report', requireRole('admin', 'manager'), slaReport);
router.get('/', list);
router.post('/', create);
router.get('/:id', getOne);
router.post('/:id/reply', reply);
router.patch('/:id', updateStatus);

export default router;
