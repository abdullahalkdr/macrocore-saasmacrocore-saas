import { Router } from 'express';
import { list, getOne, create, update, receive, remove } from '../controllers/purchaseOrders.controller';
import { requireAuth } from '../middleware/auth';
import { requireRoleOrPermission } from '../middleware/requirePermission';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.get('/:id', getOne);
router.post('/', create);
router.patch('/:id', requireRoleOrPermission(['admin', 'manager'], 'approve_purchase_orders'), update);
router.post('/:id/receive', requireRoleOrPermission(['admin', 'manager'], 'approve_purchase_orders'), receive);
router.delete('/:id', requireRoleOrPermission(['admin', 'manager'], 'approve_purchase_orders'), remove);

export default router;
