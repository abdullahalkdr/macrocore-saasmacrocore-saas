import { Router } from 'express';
import { overview, listAdjustments, adjust } from '../controllers/inventory.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/overview', overview);
router.get('/adjustments', listAdjustments);
router.post('/adjustments', requireRole('admin', 'manager'), adjust);

export default router;
