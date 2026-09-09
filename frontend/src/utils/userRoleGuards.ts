// Pure predicates mirroring the backend's manager privilege-escalation guard
// in backend/src/controllers/users.controller.ts's update() (production
// review, 2026-09-09) — kept here, not inlined in UsersPage.tsx, so the
// exact boundary is unit-testable without rendering the page. Keep these two
// functions and that backend guard in sync by hand; there's no shared
// package between frontend/backend to enforce it structurally.
export type UserRole = 'admin' | 'manager' | 'employee' | 'viewer';

// Whether `viewerRole` (whoever is using the Users page) may modify the
// target row AT ALL — role, status, name, email, employee link, all of it.
// Admins can modify anyone; a manager can never modify an existing admin or
// manager account, matching users.controller.ts's update() guard exactly
// (that guard blocks the request regardless of which fields are sent).
export function canModifyUserRow(viewerRole: string, targetRole: string): boolean {
  if (viewerRole === 'admin') return true;
  return targetRole !== 'admin' && targetRole !== 'manager';
}

// The roles selectable in a row's role <select>. A manager only ever gets to
// CHOOSE employee/viewer (decision 5) — but a row they can't modify at all
// (an existing admin/manager account) must still list its own current role
// in the options, or the disabled <select> would render blank instead of
// showing the real role.
export function assignableRoleOptions(
  viewerRole: string,
  targetRole: string,
  allRoles: UserRole[],
  managerInvitableRoles: UserRole[]
): UserRole[] {
  if (viewerRole === 'admin') return allRoles;
  if (canModifyUserRow(viewerRole, targetRole)) return managerInvitableRoles;
  return allRoles;
}
