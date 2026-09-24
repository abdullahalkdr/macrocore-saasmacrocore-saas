// backend/src/config/billing.ts
//
// Stage B7 — Trial-to-paid customer self-service subscription checkout (see
// claude/chat7a-b7-customer-subscription-checkout-design-pass-v3-2026-09-24.md,
// approved design, §8.3 / decision A3).
//
// The ONE place the customer checkout window is defined. It is passed to
// PostgreSQL as an integer (`make_interval(mins => $n)`) — never added to a
// JavaScript Date. Every expiry decision is then a fresh
// `clock_timestamp() < expires_at` comparison made in SQL after the relevant
// row locks are held (design v3 R1).
export const CHECKOUT_WINDOW_MINUTES = 30;
