import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRoleOrPermission } from '../middleware/requirePermission';
import * as controller from '../controllers/companyFiles.controller';

const router = Router();

router.use(requireAuth);
router.get('/', controller.list);
router.get('/expiring/list', controller.getExpiring);
router.get('/:id', controller.getOne);
router.post('/', requireRoleOrPermission(['admin', 'manager'], 'manage_system_settings'), controller.create);
router.patch('/:id', requireRoleOrPermission(['admin', 'manager'], 'manage_system_settings'), controller.update);
router.delete('/:id', requireRoleOrPermission(['admin', 'manager'], 'manage_system_settings'), controller.remove);

export default router;
