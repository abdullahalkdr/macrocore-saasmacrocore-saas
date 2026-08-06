import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useLangStore } from '../store/langStore';
import { useThemeStore } from '../store/themeStore';
import { useT } from '../i18n';
import { get } from '../api/client';
import { planLevelOf, PLAN_TIER_NAME } from '../planLevels';
import { useUpgradeModalStore } from '../store/upgradeModalStore';
import Avatar from './Avatar';
import NotificationsBell from './NotificationsBell';
import {
  IconDashboard,
  IconSales,
  IconProduct,
  IconEmployee,
  IconBuilding,
  IconReports,
  IconExpense,
  IconTrash,
  IconPayroll,
  IconSettings,
  IconAttendance,
  IconLogout,
} from './Icon';

export default function Layout() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const company = useAuthStore((s) => s.company);
  const logout = useAuthStore((s) => s.logout);
  const lang = useLangStore((s) => s.lang);
  const toggleLang = useLangStore((s) => s.toggle);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const t = useT();

  const isManagerRole = user?.role === 'admin' || user?.role === 'manager';
  const [pendingRequests, setPendingRequests] = useState(0);

  // `company.plan` in authStore is a snapshot from whenever this browser session last
  // logged in — it never updates on its own. If Abdullah changes a tenant's plan from
  // /platform-admin while that tenant's browser tab is already open, the sidebar would
  // keep showing the OLD plan's lock state until the user manually logs out and back
  // in. Fetching the live value here (company.controller.ts getMe isn't plan-gated —
  // see app.ts) means the sidebar reflects reality within one page load/refresh
  // instead of requiring a re-login.
  const [livePlan, setLivePlan] = useState<string | null>(company?.plan ?? null);
  useEffect(() => {
    get<{ plan: string }>('/company/me')
      .then((r) => setLivePlan(r.plan))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isManagerRole) return;
    function loadPending() {
      get<{ leave_requests: unknown[] }>('/leave-requests?status=pending')
        .then((r) => setPendingRequests(r.leave_requests.length))
        .catch(() => {});
    }
    loadPending();
    const interval = setInterval(loadPending, 60000);
    return () => clearInterval(interval);
  }, [isManagerRole]);

  // Grouped like CornLab's activeNavStructure(): a labelled section per work area
  // instead of one flat list.
  const navGroups = [
    { label: t.nav.groupGeneral, items: [{ to: '/dashboard', label: t.nav.dashboard, icon: IconDashboard }] },
    {
      label: t.nav.groupDailyOps,
      items: [
        { to: '/shift', label: t.nav.shift, icon: IconSales },
        { to: '/customers', label: t.nav.customers, icon: IconEmployee, minPlan: 2 },
        { to: '/expenses', label: t.nav.expenses, icon: IconExpense },
        { to: '/waste', label: t.nav.waste, icon: IconTrash, minPlan: 2 },
      ],
    },
    {
      label: t.nav.groupProducts,
      items: [{ to: '/products', label: t.nav.products, icon: IconProduct, managerOnly: true }],
    },
    {
      label: t.nav.groupWarehouses,
      items: [
        { to: '/inventory', label: t.nav.inventory, icon: IconBuilding, managerOnly: true, minPlan: 2 },
        { to: '/raw-materials', label: t.nav.rawMaterials, icon: IconProduct, managerOnly: true },
        { to: '/raw-material-batches', label: t.nav.rawMaterialBatches, icon: IconProduct, managerOnly: true, minPlan: 2 },
        { to: '/stock-transfers', label: t.nav.stockTransfers, icon: IconBuilding, managerOnly: true, minPlan: 2 },
        { to: '/locations', label: t.nav.locations, icon: IconBuilding, managerOnly: true },
        { to: '/suppliers', label: t.nav.suppliers, icon: IconBuilding, managerOnly: true, minPlan: 2 },
        { to: '/purchase-orders', label: t.nav.purchaseOrders, icon: IconBuilding, managerOnly: true, minPlan: 2 },
      ],
    },
    {
      label: t.nav.groupHR,
      items: [
        { to: '/employees', label: t.nav.employees, icon: IconEmployee, managerOnly: true, minPlan: 2 },
        { to: '/payroll', label: t.nav.payroll, icon: IconPayroll, managerOnly: true, minPlan: 3 },
        { to: '/shift-schedule', label: t.nav.shiftSchedule, icon: IconAttendance, minPlan: 2 },
        { to: '/attendance', label: t.nav.attendance, icon: IconAttendance, minPlan: 2 },
        { to: '/leave-requests', label: t.nav.leaveRequests, icon: IconAttendance, minPlan: 2 },
      ],
    },
    {
      label: t.nav.groupReportsDocs,
      items: [
        { to: '/reports', label: t.nav.reports, icon: IconReports },
        { to: '/official-documents', label: t.nav.officialDocuments, icon: IconReports, managerOnly: true, minPlan: 2 },
        { to: '/company-files', label: t.nav.companyFiles, icon: IconReports, managerOnly: true, minPlan: 2 },
        { to: '/audit-log', label: t.nav.auditLog, icon: IconReports, managerOnly: true, minPlan: 3 },
      ],
    },
    {
      label: t.nav.groupSettings,
      items: [
        { to: '/users', label: t.nav.users, icon: IconSettings, managerOnly: true },
        { to: '/permissions', label: t.nav.permissions, icon: IconSettings, adminOnly: true, minPlan: 3 },
        { to: '/settings', label: t.nav.settings, icon: IconSettings, managerOnly: true },
        { to: '/support', label: t.nav.support, icon: IconSettings },
      ],
    },
  ];

  function handleLogout() {
    logout();
    navigate('/login');
  }

  const isManager = user?.role === 'admin' || user?.role === 'manager';
  const isAdmin = user?.role === 'admin';
  const companyPlanLevel = planLevelOf(livePlan ?? company?.plan);
  const openUpgradeModal = useUpgradeModalStore((s) => s.openModal);
  // Role gating still hides the item outright (an employee was never going to see
  // Payroll regardless of plan). Plan gating is different on purpose, matching the
  // Wafeq reference the user pointed to: the item stays visible with a tier badge, and
  // clicking it opens the upgrade modal instead of navigating — showing what's
  // missing sells the upgrade far better than hiding it ever could. The backend
  // (requirePlanLevel) is the real enforcement either way; this is UX only.
  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (i) => (!('managerOnly' in i) || !i.managerOnly || isManager) && (!('adminOnly' in i) || !i.adminOnly || isAdmin)
      ),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <div className="app-shell">
      <div className="sidebar">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h1>{company?.name || 'macrocore'}</h1>
          <NotificationsBell />
        </div>
        {visibleGroups.map((group) => (
          <div key={group.label} style={{ padding: '10px 10px 4px' }}>
            <div style={{ fontSize: 10, color: '#6b6560', fontWeight: 700, padding: '8px 8px 4px', letterSpacing: '.03em' }}>
              {group.label}
            </div>
            <nav>
              {group.items.map((l) => {
                const minPlan = 'minPlan' in l ? l.minPlan : undefined;
                const locked = !!minPlan && companyPlanLevel < minPlan;
                // Only ever badge a LOCKED item — once the plan covers it, the item
                // looks exactly like any other nav link. A permanent "this is a Silver
                // feature" tag even after upgrading is exactly what read as "nothing
                // changed" when Abdullah tested this.
                const badge = locked ? (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 800,
                      padding: '2px 6px',
                      borderRadius: 999,
                      background: 'var(--amber-500)',
                      color: '#fff',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {PLAN_TIER_NAME[minPlan!] ?? ''}
                  </span>
                ) : null;

                if (locked) {
                  return (
                    <button
                      key={l.to}
                      type="button"
                      onClick={() => openUpgradeModal(t.pricing.blockedBannerDefault)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        width: '100%',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        opacity: 0.7,
                        textAlign: 'start',
                      }}
                    >
                      <l.icon />
                      <span style={{ flex: 1 }}>{l.label}</span>
                      {badge}
                    </button>
                  );
                }

                return (
                  <NavLink
                    key={l.to}
                    to={l.to}
                    className={({ isActive }) => (isActive ? 'active' : '')}
                    style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                  >
                    <l.icon />
                    <span style={{ flex: 1 }}>{l.label}</span>
                    {badge}
                    {l.to === '/leave-requests' && pendingRequests > 0 && (
                      <span
                        style={{
                          minWidth: 18,
                          height: 18,
                          padding: '0 5px',
                          borderRadius: 999,
                          background: '#dc2626',
                          color: '#fff',
                          fontSize: 11,
                          fontWeight: 800,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          lineHeight: 1,
                        }}
                      >
                        {pendingRequests}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </nav>
          </div>
        ))}
        <div style={{ marginTop: 'auto', padding: '10px 12px', display: 'flex', gap: 6 }}>
          <button className="btn btn-secondary btn-sm" style={{ flex: 1, justifyContent: 'center' }} onClick={toggleLang}>
            {lang === 'ar' ? 'English' : 'العربية'}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            style={{ justifyContent: 'center', paddingInline: 10 }}
            onClick={toggleTheme}
            title={theme === 'dark' ? t.common.lightMode : t.common.darkMode}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 4px' }}>
          <div
            onClick={() => navigate('/account')}
            title={t.account.title}
            style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '10px 8px', borderRadius: 10 }}
          >
            <Avatar name={user?.email || '?'} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user?.email}
              </div>
              <div style={{ fontSize: 10, color: 'var(--stone-400)' }}>{user?.role}</div>
            </div>
          </div>
          <button className="icon-btn" onClick={handleLogout} title={t.common.logout} style={{ color: 'var(--stone-400)' }}>
            <IconLogout />
          </button>
        </div>
      </div>
      <div className="main">
        <Outlet />
      </div>
    </div>
  );
}
