import { Router } from 'express';
import { create, list, remove, update } from '../controllers/sales.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.post('/', create);
router.get('/', list);
router.patch('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', remove);

export default router;
