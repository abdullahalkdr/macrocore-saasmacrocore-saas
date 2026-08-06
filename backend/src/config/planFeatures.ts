// Single source of truth for "which plan unlocks what" — see
// docs/macrocore-خارطة-طريق.md section "المرحلة 4" for the product decision this
// implements, and app.ts for where each router is actually gated.
//
// 'trial' is pinned to Silver (level 2) — enough for a prospect to see the
// mid-tier feature set (employees, inventory, suppliers, etc.), not the full Gold
// set they haven't committed to paying for. requireActiveSubscription
// (middleware/subscription.ts) is what cuts access off once the 14-day trial or
// paid subscription actually lapses; this file only decides which FEATURES a given
// plan unlocks while access is otherwise valid.
export const PLAN_LEVEL: Record<string, number> = {
  bronze: 1,
  silver: 2,
  gold: 3,
  enterprise: 4,
  trial: 2,
};

export function planLevelOf(plan: string): number {
  return PLAN_LEVEL[plan] ?? 0; // unknown plan value = no access, fail closed
}

// Bronze ("a kiosk or a single branch getting started" — see PricingPage.tsx) is
// priced for one location. Silver+ is unlimited. This isn't a route gate (every
// plan needs at least one location — shifts.controller.ts open() requires
// location_id) so it's enforced as a quantity check in locations.controller.ts
// create() instead of the requirePlanLevel router gate below.
export const BRONZE_LOCATION_LIMIT = 1;

export const PLAN_NAMES: Record<number, string> = {
  2: 'Silver',
  3: 'Gold',
};
