import { Router } from 'express';
import { open, close, getOne, list, update, remove, updateReconciliation } from '../controllers/shifts.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.post('/', open);
router.get('/', list);
router.patch('/:id/reconciliation', requireRole('admin', 'manager'), updateReconciliation);
router.patch('/:id', close);
router.put('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', requireRole('admin', 'manager'), remove);
router.get('/:id', getOne);

export default router;
