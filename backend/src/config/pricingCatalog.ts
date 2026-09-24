// backend/src/config/pricingCatalog.ts
//
// Server-authoritative list prices confirmed by Abdullah as the prices
// currently shown on macrocore.io. USD is the collection currency; the KD
// figures on the public page remain exchange-rate-dependent display values.
// Annual values are full-cycle charges: 26/32/55 USD monthly-equivalent
// multiplied by 12, matching the totals shown by the Wafeq reference.
//
// Stage B7 (design v3 §7.1, correction 6 / decision A7): prices are canonical
// DECIMAL STRINGS with exactly the currency's minor-unit precision (USD = 2).
// B7 passes these strings to PostgreSQL unchanged (`$n::numeric`) and never
// holds a charge in a JavaScript number. B2's admin activation compares its
// admin-supplied JSON number against these strings exactly (see
// utils/subscriptionLifecycle.ts::resolvePeriodAmount) — no float tolerance.
//
// frontend/src/pricingData.ts still mirrors these for the unauthenticated
// public PricingPage only; every in-app purchase surface reads
// GET /api/billing/plans instead.

import type { PricingCatalog } from '../utils/subscriptionLifecycle';

export const APPROVED_PRICING_CATALOG: PricingCatalog = {
  currency: 'USD',
  prices: {
    bronze: { monthly: '32.00', annual: '312.00' },
    silver: { monthly: '39.00', annual: '384.00' },
    gold: { monthly: '67.00', annual: '660.00' },
  },
};
