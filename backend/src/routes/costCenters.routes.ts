import { Router } from 'express';
import { list, getOne, create, update, remove } from '../controllers/costCenters.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.get('/:id', getOne);
router.post('/', requireRole('admin', 'manager'), create);
router.patch('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
