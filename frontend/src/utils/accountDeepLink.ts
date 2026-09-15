// Pure, independently-testable building block for AccountSettingsPage.tsx's
// `?section=` deep-link handling — Chat 4B, Stage B4A adds the 'billing'
// case below (the billing-activated/invoice-issued emails link here via
// `${FRONTEND_URL}/account?section=billing`). See
// claude/chat4b-b4a-immediate-subscription-invoice-emails-2026-09-15.md
// (project doc).
//
// Deliberately narrow allowlist, not a passthrough of the raw query value:
// AccountSettingsPage.tsx's own SectionId union has several admin-only
// sections (company/billing/users/setup/customizations/developer) that must
// never open for a plain employee just because they were handed (or crafted)
// a query string. 'profile' has been the one section a query param could
// open since the Policy Gate pilot (no admin gate needed — every signed-in
// user has their own Profile). 'billing' is the one new case this stage
// adds, and ONLY for an authenticated tenant admin — passing isAdmin=false
// (or omitting it) must behave exactly as if the query param were absent.
//
// Returns null — never 'index' — for "no deep link matched": the caller
// distinguishes "open this section" from "leave whatever section is already
// showing alone" (see AccountSettingsPage.tsx's effect, which must NOT reset
// an admin who navigated to /account?section=billing while already on some
// OTHER section back to the index).
export type AccountSectionId =
  | 'index'
  | 'profile'
  | 'company'
  | 'billing'
  | 'users'
  | 'setup'
  | 'customizations'
  | 'developer'
  | 'emailDelivery';

export function resolveAccountDeepLinkSection(section: string | null, isAdmin: boolean): AccountSectionId | null {
  if (section === 'profile') return 'profile';
  if (section === 'billing' && isAdmin) return 'billing';
  return null;
}
