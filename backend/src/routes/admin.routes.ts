import { Router } from 'express';
import {
  listCompanies,
  updateCompany,
  listSubscriptions,
  listInvoices,
  stats,
  activateSubscription,
  getCompanySubscription,
  createSubscriptionInvoice,
  createPaymentAttempt,
  listPaymentAttempts,
  markPaymentAttemptFailed,
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
// Stage B3 — subscription invoice foundation (see admin.controller.ts).
router.post('/companies/:id/subscription/invoices', createSubscriptionInvoice);
// Stage B5 — provider-neutral payment attempt engine (see admin.controller.ts).
// Administrative record of an attempt to collect on an already-'issued'
// invoice; creating or failing an attempt is never proof of payment and
// never activates/changes a subscription, invoice, or company.
router.post('/invoices/:invoiceId/payment-attempts', createPaymentAttempt);
router.get('/invoices/:invoiceId/payment-attempts', listPaymentAttempts);
router.post('/payment-attempts/:id/mark-failed', markPaymentAttemptFailed);

export default router;
