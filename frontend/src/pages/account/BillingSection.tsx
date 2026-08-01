import { useEffect, useState } from 'react';
import { get, ApiError } from '../../api/client';
import { useT } from '../../i18n';

interface CompanyMe {
  name: string;
  plan: string;
  subscription_status: string;
  trial_end_date: string | null;
  branches_count: number;
}

export default function BillingSection() {
  const t = useT();
  const [data, setData] = useState<CompanyMe | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<CompanyMe>('/company/me')
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : t.account.loadFailed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="muted">{t.common.loading}</div>;

  const trialDaysLeft = data.trial_end_date
    ? Math.max(0, Math.ceil((new Date(data.trial_end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;
  const isTrial = data.subscription_status === 'trial';

  function ComingSoonBtn() {
    return (
      <button className="btn btn-secondary btn-sm" type="button" disabled title={t.account.comingSoon}>
        {t.account.billing.buyAddon} · {t.account.comingSoon}
      </button>
    );
  }

  return (
    <div>
      <div className="card">
        <div className="card-head">
          <h2>{t.account.billing.planDetails}</h2>
        </div>
        <div className="card-body">
          <div className="field-grid">
            <div className="stat-card">
              <div className="stat-label">{t.account.billing.currentPlan}</div>
              <div className="stat-value" style={{ fontSize: 16 }}>
                {data.plan}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">{t.account.billing.status}</div>
              <div className="stat-value" style={{ fontSize: 14 }}>
                {isTrial && trialDaysLeft !== null ? t.account.billing.trialStatus(trialDaysLeft) : t.account.billing.activeStatus}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">{t.account.billing.branches}</div>
              <div className="stat-value">{data.branches_count}</div>
            </div>
          </div>

          <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'var(--stone-50)', borderRadius: 10 }}>
              <span style={{ fontSize: 13 }}>{t.account.billing.advancedCustomization}</span>
              <ComingSoonBtn />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'var(--stone-50)', borderRadius: 10 }}>
              <span style={{ fontSize: 13 }}>{t.account.billing.revenueRecognition}</span>
              <ComingSoonBtn />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t.account.billing.billingAccount}</h2>
        </div>
        <div className="card-body">
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            {t.account.comingSoon} — {t.account.billing.paymentLinkHint}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" disabled title={t.account.comingSoon}>
              {t.account.billing.updatePaymentMethod}
            </button>
            <button className="btn btn-secondary btn-sm" disabled title={t.account.comingSoon}>
              {t.account.billing.getPaymentLink}
            </button>
          </div>
          <div style={{ marginTop: 12, fontSize: 13 }}>
            {t.account.billing.balance}: <strong>0.00</strong>
          </div>
        </div>
      </div>
    </div>
  );
}
