import { ComponentType, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useLangStore } from '../store/langStore';
import { useThemeStore } from '../store/themeStore';
import { useT } from '../i18n';
import { get, post } from '../api/client';
import { planLevelOf, PLAN_TIER_NAME } from '../planLevels';
import { useUpgradeModalStore } from '../store/upgradeModalStore';
import { usePermissionsStore } from '../store/usePermissionsStore';
import Avatar from './Avatar';
import NotificationsBell from './NotificationsBell';
import AcknowledgmentModal from './AcknowledgmentModal';
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
  IconMenu,
  IconClose,
  IconApproval,
} from './Icon';

type IconType = ComponentType<{ size?: number }>;
interface NavItem {
  to: string;
  label: string;
  icon: IconType;
  minPlan?: number;
  managerOnly?: boolean;
  adminOnly?: boolean;
  // MIGRATION_054 — an employee individually or by-job-role granted this exact
  // permission key sees the item even though managerOnly/adminOnly would otherwise hide
  // it. Only ever WIDENS visibility on top of the role check below, never narrows it —
  // an item with no `permission` set behaves exactly as before this existed.
  permission?: string;
}
interface NavGroup {
  label: string;
  items: NavItem[];
  accordion?: boolean;
  // Stable identity for an accordion group, independent of `parentLabel` (which is a
  // translated string that changes with `lang` — can't be used as a toggle/ref key).
  key?: string;
  parentLabel?: string;
  parentIcon?: IconType;
  // Sales-only visual detail preserved from the original single-group flyout: its last
  // item (Sales Settings) reads as a distinct trailing action, separated by a divider,
  // rather than just another item in the list. Off by default for the newly-converted
  // groups below — none of their trailing items are a settings-style outlier the same
  // way, so they render as one plain list.
  dividerBeforeLast?: boolean;
}

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

  // Off-canvas sidebar for phones/narrow windows — below 860px the sidebar used to
  // just stack above the page content in full (every nav item, full height), which on
  // a phone-sized viewport meant the sidebar alone filled the entire screen and the
  // actual page was scrolled miles below it. Now it's a hidden drawer toggled by a
  // hamburger button in a small top bar (see styles.css's 860px media query), closes
  // itself on navigation or on tapping the backdrop.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Unverified-email reminder — non-blocking on purpose (login itself never checks
  // email_verified, see auth.controller.ts's login()): blocking a real customer out
  // over a missed verification email is worse for signup conversion than a dismissible
  // banner. Dismiss is per-session only (not persisted) — it comes back on next login
  // until the account is actually verified, so it can't be permanently ignored.
  const [verifyBannerDismissed, setVerifyBannerDismissed] = useState(false);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');
  async function handleResendVerification() {
    setResendState('sending');
    try {
      await post('/auth/resend-verification', {});
      setResendState('sent');
    } catch {
      setResendState('idle');
    }
  }

  // `company.plan` in authStore is a snapshot from whenever this browser session last
  // logged in — it never updates on its own. If Abdullah changes a tenant's plan from
  // /platform-admin while that tenant's browser tab is already open, the sidebar would
  // keep showing the OLD plan's lock state until the user manually logs out and back
  // in. Fetching the live value here (company.controller.ts getMe isn't plan-gated —
  // see app.ts) means the sidebar reflects reality within one page load/refresh
  // instead of requiring a re-login.
  const [livePlan, setLivePlan] = useState<string | null>(company?.plan ?? null);
  // GLOBAL UNLOCK — mirrors the backend's env.BYPASS_PLAN_GATING (dev/test only, see
  // requirePlan.ts/company.controller.ts). When true, the backend no longer enforces
  // any plan-tier gate, so keeping the sidebar's locked badges/upgrade-modal prompts up
  // would be actively misleading — every item they'd block is actually reachable.
  const [planGatingBypassed, setPlanGatingBypassed] = useState(false);
  const updateCompany = useAuthStore((s) => s.updateCompany);
  useEffect(() => {
    get<{ plan: string; plan_gating_bypassed?: boolean }>('/company/me')
      .then((r) => {
        setLivePlan(r.plan);
        setPlanGatingBypassed(!!r.plan_gating_bypassed);
        // Also push into the shared authStore so pages that don't poll /company/me
        // themselves (e.g. PayrollPage.tsx's Performance-linked adjustments check)
        // can read the live bypass state via useAuthStore(s => s.company) instead of
        // duplicating this fetch.
        updateCompany({ plan: r.plan, plan_gating_bypassed: !!r.plan_gating_bypassed });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Own effective permission set (job-role + individual layers, MIGRATION_054) — fetched
  // once per mount, same pattern as livePlan above. Layout mounts fresh on every
  // login/page-load inside ProtectedRoute, so this is always current for the session.
  const fetchMyPermissions = usePermissionsStore((s) => s.fetchMyPermissions);
  const permissionKeys = usePermissionsStore((s) => s.permissionKeys);
  useEffect(() => {
    fetchMyPermissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // MIGRATION_055 — pending approval-workflow count for the sidebar badge. Gated on
  // BOTH isManagerRole and the live plan level (gold, same as the /api/approvals route
  // gate in app.ts) — polling a gold-gated route in the background for a Bronze/Silver
  // company would 403 with PLAN_UPGRADE_REQUIRED every 60s and auto-pop the global
  // upgrade modal unprompted (api/client.ts's interceptor does this for ANY 403 with
  // that code, not just user-initiated navigation) — the exact bug already caught and
  // fixed once for /permissions/my-permissions earlier in this project; not repeating
  // it here for a second endpoint.
  const [pendingApprovals, setPendingApprovals] = useState(0);
  useEffect(() => {
    if (!isManagerRole) return;
    // GLOBAL UNLOCK — /api/approvals is reachable by every company while
    // planGatingBypassed is true (requirePlan.ts), so the badge should poll
    // regardless of the company's real stored plan level.
    if (!planGatingBypassed && planLevelOf(livePlan ?? company?.plan) < 3) return;
    function loadPendingApprovals() {
      get<{ requests: unknown[] }>('/approvals/pending')
        .then((r) => setPendingApprovals(r.requests.length))
        .catch(() => {});
    }
    loadPendingApprovals();
    const interval = setInterval(loadPendingApprovals, 60000);
    return () => clearInterval(interval);
  }, [isManagerRole, livePlan, company?.plan, planGatingBypassed]);

  // Grouped like CornLab's activeNavStructure(): a labelled section per work area
  // instead of one flat list.
  //
  // "المبيعات" (Sales) below is special: it's an accordion, not a flat item list — per
  // Abdullah's Wafeq reference, clicking the parent expands/collapses its 8 sub-items
  // (Customers, Quotes, Sales Invoices, Customer Receipts, Recurring Invoices, Credit
  // Notes, Cash Invoices, Sales Settings) in place, rather than hiding them behind a
  // whole separate icon-rail+flyout navigation paradigm (which would look inconsistent
  // with every other section of this sidebar staying as plain expanded text lists).
  // Deliberately separate from `shift` (POS/cash-register selling) — see app.ts's
  // comment on why POS sales and this new B2B invoicing suite are two independent
  // systems, not one.
  const navGroups: NavGroup[] = [
    {
      label: t.nav.groupGeneral,
      items: [
        { to: '/dashboard', label: t.nav.dashboard, icon: IconDashboard },
        // MIGRATION_055 — kept flat (not folded into an accordion group) and right next
        // to Dashboard on purpose: this is a daily action item for whoever holds it, not
        // reference/config content — same prominence leave-requests already gets via
        // its own badge. managerOnly for now; individual non-manager permission holders
        // (MODULE_APPROVER_PERMISSION in approvals.controller.ts) can still act via the
        // API/direct URL, they just don't get a sidebar entry yet — a real but small gap,
        // flagged rather than silently left.
        { to: '/approvals', label: t.nav.approvals, icon: IconApproval, managerOnly: true, minPlan: 3 },
      ],
    },
    {
      label: t.nav.groupDailyOps,
      items: [
        { to: '/shift', label: t.nav.shift, icon: IconSales },
        { to: '/expenses', label: t.nav.expenses, icon: IconExpense },
        { to: '/waste', label: t.nav.waste, icon: IconTrash, minPlan: 2 },
      ],
    },
    {
      label: '',
      accordion: true,
      key: 'sales',
      dividerBeforeLast: true,
      parentLabel: t.nav.groupSales,
      parentIcon: IconSales,
      items: [
        { to: '/customers', label: t.nav.customers, icon: IconEmployee, minPlan: 2 },
        { to: '/quotes', label: t.nav.quotes, icon: IconReports, minPlan: 2 },
        { to: '/sales-invoices', label: t.nav.salesInvoices, icon: IconSales, minPlan: 2 },
        { to: '/customer-receipts', label: t.nav.customerReceipts, icon: IconReports, minPlan: 2 },
        { to: '/recurring-invoices', label: t.nav.recurringInvoices, icon: IconReports, minPlan: 2 },
        { to: '/credit-notes', label: t.nav.creditNotes, icon: IconReports, minPlan: 2 },
        { to: '/cash-invoices', label: t.nav.cashInvoices, icon: IconReports, minPlan: 2 },
        { to: '/sales-settings', label: t.nav.salesSettings, icon: IconSettings },
      ],
    },
    {
      label: t.nav.groupProducts,
      items: [{ to: '/products', label: t.nav.products, icon: IconProduct, managerOnly: true }],
    },
    // Warehouses, HR, Reports & Documents, and Settings & Support — same accordion
    // flyout treatment as Sales above, converted because each grew to 4-7 flat items
    // and made the sidebar too long to scan at a glance (Abdullah's "too cluttered"
    // feedback). Their small uppercase section label is dropped in favor of the
    // clickable parentLabel header, exactly like Sales already worked.
    {
      label: '',
      accordion: true,
      key: 'warehouses',
      parentLabel: t.nav.groupWarehouses,
      parentIcon: IconBuilding,
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
      label: '',
      accordion: true,
      key: 'hr',
      parentLabel: t.nav.groupHR,
      parentIcon: IconEmployee,
      items: [
        { to: '/employees', label: t.nav.employees, icon: IconEmployee, managerOnly: true, minPlan: 2 },
        { to: '/departments', label: t.nav.departments, icon: IconEmployee, managerOnly: true },
        { to: '/payroll', label: t.nav.payroll, icon: IconPayroll, managerOnly: true, minPlan: 3, permission: 'manage_payroll' },
        { to: '/shift-schedule', label: t.nav.shiftSchedule, icon: IconAttendance, minPlan: 2 },
        { to: '/attendance', label: t.nav.attendance, icon: IconAttendance, minPlan: 2 },
        { to: '/leave-requests', label: t.nav.leaveRequests, icon: IconAttendance, minPlan: 2 },
        { to: '/policies', label: t.nav.policies, icon: IconReports, minPlan: 2 },
        { to: '/hr-dashboard', label: t.nav.hrDashboard, icon: IconReports, managerOnly: true, minPlan: 3 },
        { to: '/performance', label: t.nav.performance, icon: IconEmployee, managerOnly: true, minPlan: 3 },
      ],
    },
    {
      label: '',
      accordion: true,
      key: 'reportsDocs',
      parentLabel: t.nav.groupReportsDocs,
      parentIcon: IconReports,
      items: [
        { to: '/reports', label: t.nav.reports, icon: IconReports },
        { to: '/official-documents', label: t.nav.officialDocuments, icon: IconReports, managerOnly: true, minPlan: 2 },
        { to: '/company-files', label: t.nav.companyFiles, icon: IconReports, managerOnly: true, minPlan: 2 },
        { to: '/audit-log', label: t.nav.auditLog, icon: IconReports, managerOnly: true, minPlan: 3, permission: 'view_audit_log' },
      ],
    },
    {
      label: '',
      accordion: true,
      key: 'settings',
      parentLabel: t.nav.groupSettings,
      parentIcon: IconSettings,
      items: [
        { to: '/users', label: t.nav.users, icon: IconSettings, managerOnly: true },
        { to: '/permissions', label: t.nav.permissions, icon: IconSettings, adminOnly: true, minPlan: 3 },
        { to: '/settings', label: t.nav.settings, icon: IconSettings, managerOnly: true },
      ],
    },
    // MIGRATION_056 — Helpdesk/Service Catalog moved out of Settings & Support into
    // its own accordion group, per the ITSM multi-step approval upgrade request.
    // Same three routes as before (unchanged), just regrouped.
    {
      label: '',
      accordion: true,
      key: 'itSupport',
      parentLabel: t.nav.groupItSupport,
      parentIcon: IconSettings,
      items: [
        { to: '/support', label: t.nav.support, icon: IconSettings },
        { to: '/service-catalog', label: t.nav.serviceCatalog, icon: IconSettings, managerOnly: true },
        { to: '/sla-management', label: t.nav.slaManagement, icon: IconSettings, managerOnly: true, minPlan: 3 },
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
      items: group.items.filter((i) => {
        const roleOk = (!('managerOnly' in i) || !i.managerOnly || isManager) && (!('adminOnly' in i) || !i.adminOnly || isAdmin);
        if (roleOk) return true;
        // Permission override (MIGRATION_054): only fires when roleOk is false, so this
        // can never hide an item the role check already shows — see NavItem.permission.
        return !!i.permission && permissionKeys.includes(i.permission);
      }),
    }))
    .filter((group) => group.items.length > 0);

  // Inline accordion — per Abdullah's 3R reference: a group expands IN PLACE right
  // below its own header, pushing the rest of the sidebar list down, instead of a
  // floating panel beside/over the sidebar. Any number of groups can be open at once
  // (Set, not a single key) — matches the reference showing two groups expanded
  // simultaneously. Plain conditional rendering, no position:fixed/portal/z-index at
  // all: it's normal document flow inside .sidebar's own scroll, so none of the
  // WebKit position:fixed-inside-overflow:auto bugs the old flyout kept running into
  // even apply here.
  const location = useLocation();
  useEffect(() => {
    setMobileNavOpen(false);
    setExpandedGroupKeys(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(new Set());

  function toggleGroup(key: string) {
    setExpandedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderNavItem(l: NavItem) {
    const minPlan = 'minPlan' in l ? l.minPlan : undefined;
    // GLOBAL UNLOCK — nothing is locked while the backend has plan gating suspended;
    // showing a lock badge for something the API will actually let you through to
    // would be a straight-up lie to the user.
    const locked = !planGatingBypassed && !!minPlan && companyPlanLevel < minPlan;
    // Only ever badge a LOCKED item — once the plan covers it, the item looks exactly
    // like any other nav link. A permanent "this is a Silver feature" tag even after
    // upgrading is exactly what read as "nothing changed" when Abdullah tested this.
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
      <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'active' : '')} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
        {l.to === '/approvals' && pendingApprovals > 0 && (
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
            {pendingApprovals}
          </span>
        )}
      </NavLink>
    );
  }

  return (
    <div className="app-shell">
      <AcknowledgmentModal />
      <div className="mobile-topbar">
        <button type="button" className="mobile-menu-btn" onClick={() => setMobileNavOpen(true)} title={t.common.menu}>
          <IconMenu />
        </button>
        <h1>{company?.name || 'macrocore'}</h1>
        <NotificationsBell />
      </div>
      {mobileNavOpen && <div className="sidebar-backdrop" onClick={() => setMobileNavOpen(false)} />}
      <div className={`sidebar${mobileNavOpen ? ' mobile-open' : ''}`}>
        <button type="button" className="mobile-close-btn" onClick={() => setMobileNavOpen(false)} title={t.common.close}>
          <IconClose size={18} />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h1>{company?.name || 'macrocore'}</h1>
          <NotificationsBell />
        </div>
        {visibleGroups.map((group, gi) => {
          const isOpen = !!group.accordion && expandedGroupKeys.has(group.key!);
          const groupActive = group.accordion && (isOpen || group.items.some((i) => i.to === location.pathname));
          return (
            <div key={group.key ?? group.label ?? gi} style={{ padding: '10px 10px 4px' }}>
              {!group.accordion && group.label && (
                <div style={{ fontSize: 10, color: '#6b6560', fontWeight: 700, padding: '8px 8px 4px', letterSpacing: '.03em' }}>
                  {group.label}
                </div>
              )}
              {group.accordion ? (
                // Inline accordion (per Abdullah's 3R reference): the sublist expands
                // directly below this button in normal document flow, pushing the
                // groups after it down the page. No portal, no position:fixed, no
                // backdrop — plain conditional rendering, so none of the WebKit
                // position:fixed-inside-overflow:auto bugs the old flyout kept running
                // into can even occur here.
                <div className="nav-accordion-wrap">
                  <button
                    type="button"
                    className={`nav-accordion-head${groupActive ? ' open' : ''}`}
                    onClick={() => toggleGroup(group.key!)}
                  >
                    {group.parentIcon ? <group.parentIcon /> : null}
                    <span style={{ flex: 1 }}>{group.parentLabel}</span>
                    <span className="nav-accordion-toggle" aria-hidden="true">
                      {isOpen ? '−' : '+'}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="nav-accordion-sublist">
                      {group.dividerBeforeLast ? (
                        <>
                          {group.items.slice(0, -1).map((l) => renderNavItem(l))}
                          <div className="nav-accordion-divider" />
                          {renderNavItem(group.items[group.items.length - 1])}
                        </>
                      ) : (
                        group.items.map((l) => renderNavItem(l))
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <nav>{group.items.map((l) => renderNavItem(l))}</nav>
              )}
            </div>
          );
        })}
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
        {user && user.email_verified === false && !verifyBannerDismissed && (
          <div className="error-banner" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ flex: 1 }}>{t.auth.verifyBannerText}</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleResendVerification}
              disabled={resendState !== 'idle'}
            >
              {resendState === 'sent' ? t.auth.verifyBannerSent : resendState === 'sending' ? t.common.loading : t.auth.verifyBannerResend}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setVerifyBannerDismissed(true)}
              title={t.common.close}
            >
              <IconClose size={16} />
            </button>
          </div>
        )}
        <Outlet />
      </div>
    </div>
  );
}
