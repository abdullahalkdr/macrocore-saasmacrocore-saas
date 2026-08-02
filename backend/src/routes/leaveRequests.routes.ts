import { Router } from 'express';
import { create, list, update, remove, calendar } from '../controllers/leaveRequests.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { requireRoleOrPermission } from '../middleware/requirePermission';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.get('/calendar', calendar);
router.post('/', create);
router.patch('/:id', requireRoleOrPermission(['admin', 'manager'], 'approve_leave'), update);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
