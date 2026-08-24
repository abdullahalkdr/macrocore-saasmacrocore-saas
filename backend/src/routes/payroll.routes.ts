import { Router } from 'express';
import { list, getOne, create, pay, update, remove } from '../controllers/payroll.controller';
import { requireAuth } from '../middleware/auth';
import { requireRoleOrPermission } from '../middleware/requirePermission';

const router = Router();

// list()/getOne() stay open to any authenticated user (requireAuth only) — the row-level
// restriction (a plain employee only ever sees their own payroll) is enforced inside the
// controller, not the route, since it depends on per-row employee_id, not just role.
router.use(requireAuth);
router.get('/', list);
router.get('/:id', getOne);
router.post('/', requireRoleOrPermission(['admin', 'manager'], 'manage_payroll'), create);
router.post('/:id/pay', requireRoleOrPermission(['admin', 'manager'], 'manage_payroll'), pay);
router.patch('/:id', requireRoleOrPermission(['admin', 'manager'], 'manage_payroll'), update);
router.delete('/:id', requireRoleOrPermission(['admin', 'manager'], 'manage_payroll'), remove);

export default router;
