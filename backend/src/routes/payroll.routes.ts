import { Router } from 'express';
import { list, getOne, create, pay, update, remove } from '../controllers/payroll.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.get('/:id', getOne);
router.post('/', requireRole('admin', 'manager'), create);
router.post('/:id/pay', requireRole('admin', 'manager'), pay);
router.patch('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
