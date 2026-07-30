import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useLangStore } from '../store/langStore';
import { useT } from '../i18n';
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
  const t = useT();

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
        { to: '/raw-materials', label: t.nav.rawMaterials, icon: IconProduct, managerOnly: true },
        { to: '/raw-material-batches', label: 'دفعات المواد', icon: IconProduct, managerOnly: true },
        { to: '/stock-transfers', label: 'تحويل المخزون', icon: IconBuilding, managerOnly: true },
        { to: '/employees', label: t.nav.employees, icon: IconEmployee, managerOnly: true },
        { to: '/locations', label: t.nav.locations, icon: IconBuilding, managerOnly: true },
        { to: '/payroll', label: t.nav.payroll, icon: IconPayroll, managerOnly: true },
        { to: '/users', label: t.nav.users, icon: IconSettings, managerOnly: true },
        { to: '/official-documents', label: 'المستندات الرسمية', icon: IconReports, managerOnly: true },
        { to: '/company-files', label: 'تراخيص وعقود الشركة', icon: IconReports, managerOnly: true },
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
                  <span>{l.label}</span>
                </NavLink>
              ))}
            </nav>
          </div>
        ))}
        <div style={{ marginTop: 'auto', padding: '10px 12px' }}>
          <button className="btn btn-secondary btn-sm" style={{ width: '100%', justifyContent: 'center' }} onClick={toggleLang}>
            {lang === 'ar' ? 'English' : 'العربية'}
          </button>
        </div>
        <div className="logout" onClick={handleLogout} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar name={user?.email || '?'} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user?.email}
            </div>
            <div style={{ fontSize: 10, color: 'var(--stone-400)' }}>{user?.role}</div>
          </div>
          <IconLogout />
        </div>
      </div>
      <div className="main">
        <Outlet />
      </div>
    </div>
  );
}
