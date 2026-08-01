import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useAuthStore } from '../store/authStore';
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
  orders_today: number;
  sales_today: number;
  revenue_today: number;
  revenue_month: number;
  profit_month: number;
  cost_of_goods_month: number;
  waste_cost_month: number;
  expenses_month: number;
  payroll_cost_month: number;
  open_shifts: number;
  active_products: number;
  active_employees: number;
}

interface InventoryAlerts {
  lowStock: number;
  expiringBatches: number;
}

function expiringCount(items: { days_until_expiry?: number | null }[]): number {
  return items.filter((i) => i.days_until_expiry !== null && i.days_until_expiry !== undefined && i.days_until_expiry <= 30).length;
}

function monthLabel() {
  return new Date().toISOString().slice(0, 7);
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const isManager = user?.role === 'admin' || user?.role === 'manager';
  const [company, setCompany] = useState<CompanyMe | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [invAlerts, setInvAlerts] = useState<InventoryAlerts | null>(null);
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

  useEffect(() => {
    if (!isManager) return;
    Promise.all([
      get<{ materials: { low_stock: boolean }[] }>('/inventory/overview').catch(() => ({ materials: [] })),
      get<{ batches: { days_until_expiry: number | null }[] }>('/raw-material-batches').catch(() => ({ batches: [] })),
    ]).then(([inv, b]) => {
      setInvAlerts({
        lowStock: inv.materials.filter((m) => m.low_stock).length,
        expiringBatches: expiringCount(b.batches),
      });
    }).catch(() => {});
  }, [isManager]);

  const trialDaysLeft = company?.trial_end_date
    ? Math.max(0, Math.ceil((new Date(company.trial_end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;

  const hasAnyInvAlert = invAlerts && (invAlerts.lowStock > 0 || invAlerts.expiringBatches > 0);

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
          <StatCard label={t.dashboard.profitMonth} value={`${summary.profit_month.toFixed(3)} KD`} color="blue" />
          <StatCard label={t.dashboard.revenueMonth} value={`${summary.revenue_month.toFixed(3)} KD`} color="amber" />
          <StatCard label={t.dashboard.salesToday} value={`${summary.revenue_today.toFixed(3)} KD`} color="green" />
          <StatCard label={t.dashboard.ordersToday} value={summary.orders_today} />
        </div>
      )}

      {isManager && (
        <div className="two-col-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
          <div className="card">
            <div className="card-head">
              <h2>{t.dashboard.inventoryAlertsTitle}</h2>
            </div>
            <div className="card-body">
              {!invAlerts ? null : !hasAnyInvAlert ? (
                <p className="muted" style={{ margin: 0 }}>{t.dashboard.inventoryAlertsNone}</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {invAlerts.lowStock > 0 && (
                    <div
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                      onClick={() => navigate('/inventory')}
                    >
                      <span>{t.dashboard.inventoryAlertLowStock(invAlerts.lowStock)}</span>
                      <span className="tag red">!</span>
                    </div>
                  )}
                  {invAlerts.expiringBatches > 0 && (
                    <div
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                      onClick={() => navigate('/raw-material-batches')}
                    >
                      <span>{t.dashboard.inventoryAlertExpiring(invAlerts.expiringBatches)}</span>
                      <span className="tag amber">!</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {summary && (
            <div className="card">
              <div className="card-head">
                <h2>{t.dashboard.monthSummaryTitle(monthLabel())}</h2>
              </div>
              <div className="card-body">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="muted">{t.dashboard.netSalesRevenue}</span>
                    <span>{summary.revenue_month.toFixed(3)} KD</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="muted">{t.dashboard.cogsLine}</span>
                    <span>-{summary.cost_of_goods_month.toFixed(3)} KD</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="muted">{t.dashboard.wasteCostLine}</span>
                    <span>-{summary.waste_cost_month.toFixed(3)} KD</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="muted">{t.dashboard.opexLine}</span>
                    <span>-{summary.expenses_month.toFixed(3)} KD</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="muted">{t.dashboard.payrollLine}</span>
                    <span>-{summary.payroll_cost_month.toFixed(3)} KD</span>
                  </div>
                  <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '4px 0' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                    <span>{t.dashboard.estimatedNetProfit}</span>
                    <span style={{ color: summary.profit_month >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {summary.profit_month.toFixed(3)} KD
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
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
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/attendance')}>
            <IconAttendance /> {t.dashboard.attendanceToday}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/reports')}>
            <IconReports /> {t.dashboard.viewReports}
          </button>
        </div>
      </div>
    </div>
  );
}
