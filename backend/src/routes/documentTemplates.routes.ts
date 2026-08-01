import { Router } from 'express';
import { getDefault, upsertDefault } from '../controllers/documentTemplates.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/default', getDefault);
router.put('/default', requireRole('admin', 'manager'), upsertDefault);

export default router;
