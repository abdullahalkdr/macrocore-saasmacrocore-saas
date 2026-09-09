import { Router } from 'express';
import { list, create, update, remove } from '../controllers/expenses.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/', create);
// Phase 4 follow-up — returned Expense requester edit -- no route-level role/permission gate here anymore. update()
// itself now does the full authorization check (admin/manager/edit_expenses OR
// the requester editing their own 'returned' expense) under a row lock, because
// that decision needs the specific row's created_by + its live approval status,
// which a route-level middleware can't see without a duplicate query. See
// expenses.controller.ts's update() for the actual gate.
router.patch('/:id', update);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
