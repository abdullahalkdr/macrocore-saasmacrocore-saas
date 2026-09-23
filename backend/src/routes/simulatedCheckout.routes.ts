// Stage B6 — the hosted /simulated-checkout page (design v5 §6.4-6.6). No
// requireAuth, no requireAdminKey, no guarded/silver/gold wrapper — this
// route's own access control is entirely the token model in
// simulatedCheckout.controller.ts, exactly mirroring how a real hosted
// payment page is never behind the merchant's own tenant login either.
// Mounted in app.ts, BEFORE app.use(notFoundHandler).

import { Router } from 'express';
import { SIMULATED_CHECKOUT_HTML, SIMULATED_CHECKOUT_CSS, SIMULATED_CHECKOUT_JS } from '../controllers/simulatedCheckoutAssets';
import { getHostedCheckoutSession, resolveHostedCheckoutSession } from '../controllers/simulatedCheckout.controller';

const router = Router();

// All six required headers (five distinct lines — frame-ancestors 'none'
// and X-Frame-Options: DENY together cover "two framing headers" for
// modern vs. legacy CSP-respecting clients respectively), applied to EVERY
// response this router serves (HTML shell, JS asset, CSS asset, both JSON
// endpoints) via one middleware mounted at the very top — design v5 §6.5.
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// Static shell — zero inline <script>/style= content anywhere in this
// response body (correction #5's XSS-surface reduction). Same generic HTML
// for every session; all session-specific data arrives via the JSON fetch
// below and is rendered client-side with textContent-safe DOM building
// (app.js's escapeHtml), never server-side string interpolation.
router.get('/', (_req, res) => {
  res.type('html').send(SIMULATED_CHECKOUT_HTML);
});

router.get('/app.js', (_req, res) => {
  res.type('application/javascript').send(SIMULATED_CHECKOUT_JS);
});

router.get('/app.css', (_req, res) => {
  res.type('text/css').send(SIMULATED_CHECKOUT_CSS);
});

router.get('/api/session', getHostedCheckoutSession);
router.post('/api/resolve', resolveHostedCheckoutSession);

export default router;
