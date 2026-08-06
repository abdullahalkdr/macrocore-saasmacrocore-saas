// Single source of truth for plan/add-on pricing — shared by the public PricingPage
// and the in-app UpgradeModal (shown when a logged-in customer hits a plan-gated
// feature; see backend/src/middleware/requirePlan.ts). Keep numbers in sync with
// Abdullah's real pricing; nothing here is wired to a payment gateway yet.
export interface Plan {
  key: string;
  name: string;
  monthlyUsd: number | null;
  annualMonthlyUsd: number | null;
  monthlyKd: number | null;
  annualKd: number | null;
  featured?: boolean;
  contactSales?: boolean;
}

// DOM order is cheapest → most expensive. Rendered dir="rtl" app-wide, which visually
// reverses this to Enterprise (left) ... Bronze (right) — matches the reference
// layout without needing separate mobile/desktop ordering.
export const PLANS: Plan[] = [
  { key: 'bronze', name: 'Bronze', monthlyUsd: 32, annualMonthlyUsd: 26, monthlyKd: 9.9, annualKd: 8.0 },
  { key: 'silver', name: 'Silver', monthlyUsd: 39, annualMonthlyUsd: 32, monthlyKd: 12.0, annualKd: 9.9, featured: true },
  { key: 'gold', name: 'Gold', monthlyUsd: 67, annualMonthlyUsd: 55, monthlyKd: 20.75, annualKd: 17.0 },
  { key: 'enterprise', name: 'Enterprise', monthlyUsd: null, annualMonthlyUsd: null, monthlyKd: null, annualKd: null, contactSales: true },
];

export interface Addon {
  key: string;
  monthlyUsd: number;
  monthlyKd: number;
  annualUsd: number;
  annualKd: number;
}
export const ADDONS: Addon[] = [
  { key: 'revenue', monthlyUsd: 39, monthlyKd: 12.08, annualUsd: 390, annualKd: 120.8 },
  { key: 'custom', monthlyUsd: 29, monthlyKd: 8.98, annualUsd: 290, annualKd: 89.8 },
  { key: 'branch', monthlyUsd: 9, monthlyKd: 2.79, annualUsd: 90, annualKd: 27.9 },
];

export const SALES_EMAIL = 'abdullahkhaled37@gmail.com';
