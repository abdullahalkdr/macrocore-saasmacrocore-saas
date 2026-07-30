import { Router } from 'express';
import { list, create } from '../controllers/rawMaterials.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/', requireRole('admin', 'manager'), create);

export default router;
