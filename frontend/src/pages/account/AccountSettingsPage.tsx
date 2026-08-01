import { useState } from 'react';
import { useAuthStore } from '../../store/authStore';
import { useT } from '../../i18n';
import PageHeader from '../../components/PageHeader';
import ProfileSection from './ProfileSection';
import CompanySection from './CompanySection';
import BillingSection from './BillingSection';
import UsersRolesSection from './UsersRolesSection';
import SetupSection from './SetupSection';
import CustomizationsSection from './CustomizationsSection';
import DeveloperSection from './DeveloperSection';

type SectionId = 'index' | 'profile' | 'company' | 'billing' | 'users' | 'setup' | 'customizations' | 'developer';

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
  const [active, setActive] = useState<SectionId>('index');

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

  const customizationsGroup: SectionLink[] = isAdmin
    ? [{ id: 'customizations', title: t.account.sections.templatesTitle, desc: t.account.sections.templatesDesc, icon: '📄' }]
    : [];

  const developerGroup: SectionLink[] = isAdmin
    ? [{ id: 'developer', title: t.account.sections.apiKeysTitle, desc: t.account.sections.apiKeysDesc, icon: '🔑' }]
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
          <button className="icon-btn" onClick={() => setActive('index')} style={{ fontWeight: 700 }}>
            {t.account.backToSettings}
          </button>
          <span>›</span>
        </div>
        {active === 'profile' && <ProfileSection />}
        {active === 'company' && <CompanySection />}
        {active === 'billing' && <BillingSection />}
        {active === 'users' && <UsersRolesSection />}
        {active === 'setup' && <SetupSection />}
        {active === 'customizations' && <CustomizationsSection />}
        {active === 'developer' && <DeveloperSection />}
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
