import { Router } from 'express';
import { list, create, update, remove } from '../controllers/suppliers.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/', requireRole('admin', 'manager'), create);
router.patch('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
