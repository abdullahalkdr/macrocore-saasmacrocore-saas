import { Router } from 'express';
import {
  listCompanies,
  updateCompany,
  listSubscriptions,
  listInvoices,
  stats,
  activateSubscription,
  getCompanySubscription,
} from '../controllers/admin.controller';
import { requireAdminKey } from '../middleware/requireAdminKey';

const router = Router();

router.use(requireAdminKey);
router.get('/companies', listCompanies);
router.patch('/companies/:id', updateCompany);
router.get('/subscriptions', listSubscriptions);
router.get('/invoices', listInvoices);
router.get('/stats', stats);
// Stage B2 — activation-only lifecycle endpoints (see admin.controller.ts).
router.post('/companies/:id/subscription/activate', activateSubscription);
router.get('/companies/:id/subscription', getCompanySubscription);

export default router;
