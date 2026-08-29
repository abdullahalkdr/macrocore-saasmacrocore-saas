import { ReactNode } from 'react';
import { useAuthStore } from '../store/authStore';
import { useT } from '../i18n';
import { useHasPermission } from '../store/usePermissionsStore';

// Mirrors CornLab's MANAGER_ONLY_PAGES check: an in-place message instead of a
// redirect, matching what the backend already enforces via requireRole on the
// corresponding create/update endpoints (admin/manager only) — this just stops
// an employee/viewer from landing on a form that would 403 anyway.
//
// Optional `permission`: mirrors the nav-item `permission` field in Layout.tsx —
// only ever WIDENS access on top of the role check, never narrows it. Pass it on
// a route whose nav entry also has a `permission` set, otherwise a permission-
// granted user sees the nav link but hits this restricted wall on click (a real
// gap found while wiring up Activity Log access — fixed here per-route rather
// than opportunistically across all 54 routes).
//
// Optional `minHrAccess`/`requiresUsersAccess` — 2026-08-26, added alongside
// the department-scoped hrScope.ts work. Mirrors the SAME two fields on the
// Layout.tsx nav item for /departments and /users: those items are already
// hidden from the sidebar for a user without full HR access / users access,
// but direct URL navigation would otherwise still render the page — the
// underlying GET /departments route is deliberately left open to every role
// (see departments.routes.ts, relied on by pickers elsewhere), so this is
// the actual UI-level gate for the full department-management page itself.
//
// Optional `requiresInventory` — same day, business-type module gating (see
// requireInventoryEnabled.ts / Layout.tsx's matching NavItem field). Unlike
// every other check here, nothing overrides it — not `permission`, not admin —
// it's a company-level switch, not a per-user access level. `roles` is now
// optional so a route with no role restriction at all (e.g. /shift, open to
// every role including plain employees running the register) can still be
// wrapped just for this check.
export default function RequireRole({
  roles,
  permission,
  minHrAccess,
  requiresUsersAccess,
  requiresInventory,
  children,
}: {
  roles?: string[];
  permission?: string;
  minHrAccess?: 'direct_reports' | 'department' | 'full';
  requiresUsersAccess?: boolean;
  requiresInventory?: boolean;
  children: ReactNode;
}) {
  const user = useAuthStore((s) => s.user);
  const company = useAuthStore((s) => s.company);
  const t = useT();
  const hasPermission = useHasPermission(permission ?? '__none__');

  const isAdmin = user?.role === 'admin';
  const hrAccessRank: Record<'self' | 'direct_reports' | 'department' | 'full', number> = { self: 0, direct_reports: 1, department: 2, full: 3 };
  const hrAccessLevel = user?.hr_access_level ?? 'self';
  const hrAccessOk = !minHrAccess || isAdmin || hrAccessRank[hrAccessLevel] >= hrAccessRank[minHrAccess];
  const usersAccessOk = !requiresUsersAccess || isAdmin || !!user?.can_access_users;
  const roleOk = !user || ((!roles || roles.includes(user.role)) && hrAccessOk && usersAccessOk);

  // Hard block, checked before everything else and never overridden (see comment
  // above) — !== false so it defaults to visible before /company/me's live fetch
  // resolves, same reasoning as Layout.tsx's inventoryEnabled.
  if (user && requiresInventory && company?.inventory_enabled === false) {
    return (
      <div className="empty-state" style={{ padding: '50px 20px' }}>
        {t.common.restricted}
      </div>
    );
  }

  // `permission`, same as the matching nav-item field in Layout.tsx, is a full
  // override on top of every other check above — not just the role check — so a
  // permission grant (e.g. manage_payroll for a non-HR Finance role) behaves the
  // same whether it reaches the page from the sidebar or a direct URL.
  if (user && !roleOk && !(permission && hasPermission)) {
    return (
      <div className="empty-state" style={{ padding: '50px 20px' }}>
        {t.common.restricted}
      </div>
    );
  }

  return <>{children}</>;
}
