// Stage B7 — tenant-facing self-service billing endpoints (design v3 §7).
// Mounted in app.ts as `app.use('/api/billing', billingRoutes)` — deliberately
// NOT behind requireActiveSubscription or any plan gate (an expired trial must
// be able to buy), exactly like /api/company.

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { requireUserSession } from '../middleware/requireUserSession';
import { rateLimit } from '../middleware/rateLimit';
import { getPlans, createPurchase, getPurchase, startPurchaseCheckout } from '../controllers/billing.controller';

const router = Router();

router.use(requireAuth);

// Any authenticated identity may read the catalogue and its own current plan.
router.get('/plans', getPlans);

// Purchase-specific routes: a real signed-in user session (never an API key)
// with the tenant admin role — the same audience that already sees the
// Billing section and receives billing emails. No new permission key.
//
const purchaseGuard = [requireUserSession, requireRole('admin')];
// Shared only by the two purchase-write routes. rateLimit() owns a private
// bucket map per configured limiter, so this cannot consume /api/auth's login
// allowance for the same IP.
const purchaseWriteLimiter = rateLimit(10, 60_000);
router.post('/purchases', ...purchaseGuard, purchaseWriteLimiter, createPurchase);
router.get('/purchases/:id', ...purchaseGuard, getPurchase);
router.post('/purchases/:id/checkout', ...purchaseGuard, purchaseWriteLimiter, startPurchaseCheckout);

export default router;
