import { Router } from 'express';
import { getDefault, upsertDefault } from '../controllers/documentTemplates.controller';
import { requireAuth } from '../middleware/auth';
import { requireRoleOrPermission } from '../middleware/requirePermission';

const router = Router();

router.use(requireAuth);
router.get('/default', getDefault);
router.put('/default', requireRoleOrPermission(['admin', 'manager'], 'manage_system_settings'), upsertDefault);

export default router;
