// Frontend mirror of backend/src/config/planFeatures.ts — kept in sync manually (small,
// rarely-changing map; see that file for the reasoning on 'trial' == Silver).
// This side is UX only (which nav links to show); the backend's requirePlanLevel is
// the actual enforcement, so a stale/missing value here never grants real access.
export const PLAN_LEVEL: Record<string, number> = {
  bronze: 1,
  silver: 2,
  gold: 3,
  enterprise: 4,
  trial: 2,
};

export function planLevelOf(plan: string | undefined | null): number {
  return PLAN_LEVEL[plan ?? ''] ?? 0;
}
