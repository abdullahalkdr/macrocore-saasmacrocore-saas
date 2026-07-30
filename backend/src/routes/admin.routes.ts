import { Router } from 'express';
import { listSubscriptions, listInvoices, stats } from '../controllers/admin.controller';
import { requireAdminKey } from '../middleware/requireAdminKey';

const router = Router();

router.use(requireAdminKey);
router.get('/subscriptions', listSubscriptions);
router.get('/invoices', listInvoices);
router.get('/stats', stats);

export default router;
