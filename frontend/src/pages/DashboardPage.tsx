import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import StatCard from '../components/StatCard';
import { IconPlus, IconExpense, IconAttendance, IconReports } from '../components/Icon';

interface CompanyMe {
  id: string;
  name: string;
  plan: string;
  subscription_status: string;
  trial_end_date: string | null;
  users_count: number;
}

interface Summary {
  sales_today: number;
  revenue_today: number;
  revenue_month: number;
  open_shifts: number;
  active_products: number;
  active_employees: number;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const t = useT();
  const [company, setCompany] = useState<CompanyMe | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([get<CompanyMe>('/company/me'), get<Summary>('/reports/summary')])
      .then(([c, s]) => {
        setCompany(c);
        setSummary(s);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t.dashboard.loadFailed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trialDaysLeft = company?.trial_end_date
    ? Math.max(0, Math.ceil((new Date(company.trial_end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;

  return (
    <div>
      <PageHeader title={t.dashboard.title} subtitle={t.dashboard.subtitle(company?.name || '—')} />
      {error && <div className="error-banner">{error}</div>}

      {company && company.plan === 'trial' && trialDaysLeft !== null && (
        <div className="card" style={{ padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="tag amber">{t.dashboard.trialDaysLeft(trialDaysLeft)}</span>
          <span className="muted">{t.dashboard.usersOnAccount(company.users_count)}</span>
        </div>
      )}

      {summary && (
        <div className="stat-grid" style={{ marginBottom: 18 }}>
          <StatCard label={t.dashboard.salesToday} value={summary.sales_today} color="blue" />
          <StatCard label={t.dashboard.revenueToday} value={`${summary.revenue_today.toFixed(3)} KD`} color="green" />
          <StatCard label={t.dashboard.revenueMonth} value={`${summary.revenue_month.toFixed(3)} KD`} color="amber" />
          <StatCard label={t.dashboard.openShifts} value={summary.open_shifts} />
          <StatCard label={t.dashboard.activeProducts} value={summary.active_products} />
          <StatCard label={t.dashboard.activeEmployees} value={summary.active_employees} />
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>{t.dashboard.quickLinks}</h2>
        </div>
        <div className="card-body" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/shift')}>
            <IconPlus /> {t.dashboard.recordSale}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/expenses')}>
            <IconExpense /> {t.dashboard.recordExpense}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/waste')}>
            <IconAttendance /> {t.dashboard.logWaste}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/reports')}>
            <IconReports /> {t.dashboard.viewReports}
          </button>
        </div>
      </div>
    </div>
  );
}
