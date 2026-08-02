import { Router } from 'express';
import { list, create, update, adjustPoints, remove } from '../controllers/customers.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/', create);
router.post('/:id/points', adjustPoints);
router.patch('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
