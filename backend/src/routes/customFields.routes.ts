import { Router } from 'express';
import { list, create, remove } from '../controllers/customFields.controller';
import { requireAuth } from '../middleware/auth';
import { requireRoleOrPermission } from '../middleware/requirePermission';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/', requireRoleOrPermission(['admin', 'manager'], 'manage_system_settings'), create);
router.delete('/:id', requireRoleOrPermission(['admin', 'manager'], 'manage_system_settings'), remove);

export default router;
