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
  createCheckoutSession,
  getCheckoutSession,
  resolveCheckoutSession,
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
// Stage B6 — provider-neutral simulated payment flow (see admin.controller.ts).
// Every route below ALSO re-checks PAYMENT_SIMULATOR_OPERATIONAL + the
// attempt's own company_id against PAYMENT_SIMULATOR_COMPANY_IDS, live, on
// every call — requireAdminKey alone (already applied above) is not
// sufficient gating for this feature.
router.post('/payment-attempts/:id/checkout-session', createCheckoutSession);
router.get('/payment-attempts/:id/checkout-session', getCheckoutSession);
router.post('/payment-checkout-sessions/:id/resolve', resolveCheckoutSession);

export default router;
