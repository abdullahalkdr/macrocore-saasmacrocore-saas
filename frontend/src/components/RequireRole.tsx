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
export default function RequireRole({
  roles,
  permission,
  children,
}: {
  roles: string[];
  permission?: string;
  children: ReactNode;
}) {
  const user = useAuthStore((s) => s.user);
  const t = useT();
  const hasPermission = useHasPermission(permission ?? '__none__');

  if (user && !roles.includes(user.role) && !(permission && hasPermission)) {
    return (
      <div className="empty-state" style={{ padding: '50px 20px' }}>
        {t.common.restricted}
      </div>
    );
  }

  return <>{children}</>;
}
