import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, ApiError } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { useT } from '../i18n';
import { IconBuilding } from '../components/Icon';

// Landed on after any API call comes back 402 + code SUBSCRIPTION_INACTIVE (see
// api/client.ts). The token is still valid — only the subscription is blocked — so
// this page fetches /company/me directly (exempt from the subscription gate, see
// backend/src/app.ts) to show what plan/status the account is actually on, instead
// of just a generic "renew now" message.
interface CompanyStatus {
  name: string;
  plan: string;
  subscription_status: string;
  trial_end_date: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

export default function SubscriptionExpiredPage() {
  const navigate = useNavigate();
  const t = useT();
  const logout = useAuthStore((s) => s.logout);
  const [company, setCompany] = useState<CompanyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<CompanyStatus>('/company/me')
      .then(setCompany)
      .catch((err) => setError(err instanceof ApiError ? err.message : t.subscriptionExpired.loadFailed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isTrial = company?.plan === 'trial';

  return (
    <div className="auth-page">
      <div className="auth-box">
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div
            style={{
              width: 56,
              height: 56,
              background: 'var(--red-600, #dc2626)',
              borderRadius: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 12px',
              color: '#fff',
            }}
          >
            <IconBuilding size={26} />
          </div>
          <h1 style={{ marginBottom: 2 }}>{t.subscriptionExpired.title}</h1>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {isTrial ? t.subscriptionExpired.trialMessage : t.subscriptionExpired.inactiveMessage}
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <p className="muted" style={{ fontSize: 13, textAlign: 'center', marginBottom: 16 }}>
          {t.subscriptionExpired.body}
        </p>

        {company && (
          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <div className="stat-card">
              <div className="stat-label">{t.subscriptionExpired.plan}</div>
              <div className="stat-value" style={{ fontSize: 16 }}>{company.plan}</div>
            </div>
            <div className="stat-card red">
              <div className="stat-label">{t.subscriptionExpired.status}</div>
              <div className="stat-value" style={{ fontSize: 16 }}>{company.subscription_status}</div>
            </div>
          </div>
        )}

        {(company?.contact_email || company?.contact_phone) && (
          <p className="muted" style={{ fontSize: 12, textAlign: 'center', marginBottom: 16 }}>
            {t.subscriptionExpired.contactUs}: {company.contact_email} {company.contact_phone}
          </p>
        )}

        <button className="btn btn-primary" style={{ width: '100%', marginBottom: 8 }} onClick={() => navigate('/support')}>
          {t.subscriptionExpired.openSupportTicket}
        </button>
        <button
          className="btn btn-secondary"
          style={{ width: '100%' }}
          onClick={() => {
            logout();
            navigate('/login');
          }}
        >
          {t.subscriptionExpired.logout}
        </button>
      </div>
    </div>
  );
}
