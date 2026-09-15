// backend/src/config/pricingCatalog.ts
//
// Server-authoritative list prices confirmed by Abdullah as the prices
// currently shown on macrocore.io. USD is the collection currency; the KD
// figures on the public page remain exchange-rate-dependent display values.
// Annual values are full-cycle charges: 26/32/55 USD monthly-equivalent
// multiplied by 12, matching the totals shown by the Wafeq reference.
// Keep frontend/src/pricingData.ts in sync until a shared catalog endpoint
// replaces the public page's static data.

import type { PricingCatalog } from '../utils/subscriptionLifecycle';

export const APPROVED_PRICING_CATALOG: PricingCatalog = {
  currency: 'USD',
  prices: {
    bronze: { monthly: 32, annual: 312 },
    silver: { monthly: 39, annual: 384 },
    gold: { monthly: 67, annual: 660 },
  },
};
