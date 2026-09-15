import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import { useHasPermission } from '../../store/usePermissionsStore';
import { useT } from '../../i18n';
import PageHeader from '../../components/PageHeader';
import ProfileSection from './ProfileSection';
import CompanySection from './CompanySection';
import BillingSection from './BillingSection';
import UsersRolesSection from './UsersRolesSection';
import SetupSection from './SetupSection';
import CustomizationsSection from './CustomizationsSection';
import DeveloperSection from './DeveloperSection';
import EmailDeliverySection from './EmailDeliverySection';
import { resolveAccountDeepLinkSection, type AccountSectionId } from '../../utils/accountDeepLink';

type SectionId = AccountSectionId;

interface SectionLink {
  id: SectionId;
  title: string;
  desc: string;
  icon: string;
}

export default function AccountSettingsPage() {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const canManageSystemSettings = isAdmin || useHasPermission('manage_system_settings');
  // Policy Gate pilot (MIGRATION_074/075) — Step 3. The notification bell links here as
  // `/account?section=profile` so it always lands on the permanent "Policies &
  // Acknowledgments" card rather than trying (and failing, once dismissed) to reopen a
  // specific modal. Deliberately narrowed to the section ids resolveAccountDeepLinkSection()
  // allows a query param to open — every other SectionId still requires an explicit click
  // from the index grid, so a stray/crafted query value can never deep-link into an
  // admin-only section (company/users/setup/customizations/developer).
  //
  // Chat 4B, Stage B4A adds 'billing' to that allowlist — the subscription-activated
  // and invoice-issued billing emails link here via `?section=billing` — but ONLY for
  // an authenticated tenant admin (see resolveAccountDeepLinkSection() in
  // utils/accountDeepLink.ts for why this can't just be a passthrough of the raw query
  // value): an employee opening that same link must see the index page, exactly as if
  // the query param weren't there at all.
  //
  // BUGFIX (2026-09, first pass) — react-router doesn't remount this page for a
  // same-route navigation (e.g. clicking the bell while already on /account, on any
  // section): only searchParams changes, this component instance stays mounted.
  // Reading searchParams once into useState's initializer only ever applied on the
  // very first mount, so a bell click from an already-open Account Settings silently
  // did nothing. Fixed with an effect that re-checks searchParams and switches to
  // 'profile' when asked — still ignoring every other value (including no `section` at
  // all), so it only ever opens this one section and never resets the admin's current
  // section back to the index on an unrelated navigation.
  //
  // BUGFIX (2026-09, second pass) — that effect was keyed on [searchParams], but
  // useSearchParams() memoizes its return value on location.search (the query STRING),
  // not on the navigation event. Sequence that broke it: open Profile via a
  // notification (?section=profile) -> click "back to settings" (goToIndex below used
  // to only call setActive('index'), never touching the URL, so the address bar still
  // read ?section=profile) -> click a second notification linking to that exact same
  // "/account?section=profile". The resulting URL string is byte-for-byte identical to
  // the current one, so useSearchParams()'s memoized value never changes and this
  // effect never re-ran — the user was left on the index instead of Profile reopening.
  // Fixed by keying the effect on useLocation().key instead: react-router mints a new
  // key on every single navigate() call, even one whose resulting URL text doesn't
  // change, so this now reliably re-runs on every click regardless of the previous
  // URL. Paired with goToIndex's URL reset below so the common case (URL actually did
  // change) keeps working the same way too, and the two fixes together keep the
  // address bar and the visible section from ever disagreeing.
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [active, setActive] = useState<SectionId>(resolveAccountDeepLinkSection(searchParams.get('section'), isAdmin) ?? 'index');

  useEffect(() => {
    const requested = searchParams.get('section');
    const resolved = resolveAccountDeepLinkSection(requested, isAdmin);
    if (resolved) setActive(resolved);
    else if (requested === 'billing') setActive('index');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on the
    // navigation event (location.key) rather than searchParams's memoized value; see
    // the second-pass comment above for why.
  }, [location.key, isAdmin]);

  // Keeps the address bar in sync with the visible section when leaving Profile via
  // this button — otherwise a later notification click landing on the same
  // "?section=profile" URL would look like a no-op navigation to react-router (see the
  // effect above) even though the visible section had already moved on to the index.
  function goToIndex() {
    setActive('index');
    if (searchParams.get('section')) navigate('/account', { replace: true });
  }

  const profileGroup: SectionLink[] = [
    { id: 'profile', title: t.account.sections.profileTitle, desc: t.account.sections.profileDesc, icon: '👤' },
  ];

  const companyGroup: SectionLink[] = isAdmin
    ? [
        { id: 'company', title: t.account.sections.companyTitle, desc: t.account.sections.companyDesc, icon: '🏢' },
        { id: 'billing', title: t.account.sections.billingTitle, desc: t.account.sections.billingDesc, icon: '💳' },
        { id: 'users', title: t.account.sections.usersTitle, desc: t.account.sections.usersDesc, icon: '👥' },
      ]
    : [];

  const setupGroup: SectionLink[] = isAdmin ? [{ id: 'setup', title: t.account.sections.branchesTitle, desc: t.account.sections.branchesDesc, icon: '🏬' }] : [];

  const customizationsGroup: SectionLink[] = canManageSystemSettings
    ? [{ id: 'customizations', title: t.account.sections.templatesTitle, desc: t.account.sections.templatesDesc, icon: '📄' }]
    : [];

  const developerGroup: SectionLink[] = isAdmin
    ? [
        { id: 'developer', title: t.account.sections.apiKeysTitle, desc: t.account.sections.apiKeysDesc, icon: '🔑' },
        { id: 'emailDelivery', title: t.account.sections.emailDeliveryTitle, desc: t.account.sections.emailDeliveryDesc, icon: '📧' },
      ]
    : [];

  function renderGroup(label: string, links: SectionLink[]) {
    if (links.length === 0) return null;
    return (
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.03em', marginBottom: 10 }}>{label}</div>
        <div className="field-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {links.map((l) => (
            <button
              key={l.id}
              className="card"
              style={{ textAlign: 'start', cursor: 'pointer', border: '1px solid var(--border)' }}
              onClick={() => setActive(l.id)}
            >
              <div className="card-body" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 22 }}>{l.icon}</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--stone-900)' }}>{l.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{l.desc}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (active !== 'index') {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          <button className="icon-btn" onClick={goToIndex} style={{ fontWeight: 700 }}>
            {t.account.backToSettings}
          </button>
          <span>›</span>
        </div>
        {active === 'profile' && <ProfileSection />}
        {active === 'company' && <CompanySection />}
        {active === 'billing' && isAdmin && <BillingSection />}
        {active === 'users' && <UsersRolesSection />}
        {active === 'setup' && <SetupSection />}
        {active === 'customizations' && <CustomizationsSection />}
        {active === 'developer' && <DeveloperSection />}
        {active === 'emailDelivery' && <EmailDeliverySection />}
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={t.account.title} />
      {renderGroup(t.account.sections.profileGroup, profileGroup)}
      {renderGroup(t.account.sections.companyGroup, companyGroup)}
      {renderGroup(t.account.sections.setupGroup, setupGroup)}
      {renderGroup(t.account.sections.customizationsGroup, customizationsGroup)}
      {renderGroup(t.account.sections.developerGroup, developerGroup)}
    </div>
  );
}
