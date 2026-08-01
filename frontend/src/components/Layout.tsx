import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useLangStore } from '../store/langStore';
import { useThemeStore } from '../store/themeStore';
import { useT } from '../i18n';
import { get } from '../api/client';
import Avatar from './Avatar';
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
        { to: '/expenses', label: t.nav.expenses, icon: IconExpense },
        { to: '/waste', label: t.nav.waste, icon: IconTrash },
        { to: '/attendance', label: t.nav.attendance, icon: IconAttendance },
        { to: '/leave-requests', label: t.nav.leaveRequests, icon: IconAttendance },
      ],
    },
    {
      label: t.nav.groupManagement,
      items: [
        { to: '/products', label: t.nav.products, icon: IconProduct, managerOnly: true },
        { to: '/inventory', label: t.nav.inventory, icon: IconBuilding, managerOnly: true },
        { to: '/raw-materials', label: t.nav.rawMaterials, icon: IconProduct, managerOnly: true },
        { to: '/raw-material-batches', label: t.nav.rawMaterialBatches, icon: IconProduct, managerOnly: true },
        { to: '/stock-transfers', label: t.nav.stockTransfers, icon: IconBuilding, managerOnly: true },
        { to: '/employees', label: t.nav.employees, icon: IconEmployee, managerOnly: true },
        { to: '/locations', label: t.nav.locations, icon: IconBuilding, managerOnly: true },
        { to: '/payroll', label: t.nav.payroll, icon: IconPayroll, managerOnly: true },
        { to: '/users', label: t.nav.users, icon: IconSettings, managerOnly: true },
        { to: '/official-documents', label: t.nav.officialDocuments, icon: IconReports, managerOnly: true },
        { to: '/company-files', label: t.nav.companyFiles, icon: IconReports, managerOnly: true },
        { to: '/settings', label: t.nav.settings, icon: IconSettings, managerOnly: true },
      ],
    },
    {
      label: t.nav.groupReports,
      items: [
        { to: '/reports', label: t.nav.reports, icon: IconReports },
        { to: '/support', label: t.nav.support, icon: IconSettings },
      ],
    },
  ];

  function handleLogout() {
    logout();
    navigate('/login');
  }

  const isManager = user?.role === 'admin' || user?.role === 'manager';
  const visibleGroups = navGroups
    .map((group) => ({ ...group, items: group.items.filter((i) => !('managerOnly' in i) || !i.managerOnly || isManager) }))
    .filter((group) => group.items.length > 0);

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{company?.name || 'macrocore'}</h1>
        {visibleGroups.map((group) => (
          <div key={group.label} style={{ padding: '10px 10px 4px' }}>
            <div style={{ fontSize: 10, color: '#6b6560', fontWeight: 700, padding: '8px 8px 4px', letterSpacing: '.03em' }}>
              {group.label}
            </div>
            <nav>
              {group.items.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  className={({ isActive }) => (isActive ? 'active' : '')}
                  style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                >
                  <l.icon />
                  <span style={{ flex: 1 }}>{l.label}</span>
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
              ))}
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
