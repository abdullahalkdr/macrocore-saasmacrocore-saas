import { ReactNode } from 'react';
import { useAuthStore } from '../store/authStore';
import { useT } from '../i18n';

// Mirrors CornLab's MANAGER_ONLY_PAGES check: an in-place message instead of a
// redirect, matching what the backend already enforces via requireRole on the
// corresponding create/update endpoints (admin/manager only) — this just stops
// an employee/viewer from landing on a form that would 403 anyway.
export default function RequireRole({ roles, children }: { roles: string[]; children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const t = useT();

  if (user && !roles.includes(user.role)) {
    return (
      <div className="empty-state" style={{ padding: '50px 20px' }}>
        {t.common.restricted}
      </div>
    );
  }

  return <>{children}</>;
}
