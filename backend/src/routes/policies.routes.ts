import { Router } from 'express';
import { list, create, getOne, updateStatus, setRoles, acknowledge, listPending, setPermissionGate } from '../controllers/policies.controller';
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
// Policy Gate pilot (MIGRATION_074/075) — same admin/manager gate as setRoles above,
// same "configuring this policy's requirements" category of action.
router.post('/:id/permission-gate', requireRole('admin', 'manager'), setPermissionGate);
router.post('/:id/acknowledge', acknowledge);

export default router;
