import { Router } from 'express';
import { list, openInvoicesForCustomer, create, remove } from '../controllers/customerReceipts.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.get('/open-invoices/:customerId', openInvoicesForCustomer);
router.post('/', requireRole('admin', 'manager'), create);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
