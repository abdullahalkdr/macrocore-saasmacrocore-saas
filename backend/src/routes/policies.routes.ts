import { Router } from 'express';
import { list, create, getOne, updateStatus, setRoles, acknowledge, listPending } from '../controllers/policies.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);

router.get('/', list);
// Static path — must come before '/:id' or Express would swallow it as {id: 'pending-acknowledgment'}.
router.get('/pending-acknowledgment', listPending);
router.post('/', requireRole('admin', 'manager'), create);
router.get('/:id', getOne);
router.patch('/:id/status', requireRole('admin', 'manager'), updateStatus);
router.post('/:id/roles', requireRole('admin', 'manager'), setRoles);
router.post('/:id/acknowledge', acknowledge);

export default router;
