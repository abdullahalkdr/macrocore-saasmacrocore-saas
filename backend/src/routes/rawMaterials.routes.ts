import { Router } from 'express';
import { list, create, update } from '../controllers/rawMaterials.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/', requireRole('admin', 'manager'), create);
router.patch('/:id', requireRole('admin', 'manager'), update);

export default router;
