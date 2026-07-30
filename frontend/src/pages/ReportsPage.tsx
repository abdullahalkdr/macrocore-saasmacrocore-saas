import { useEffect, useState } from 'react';
import { get, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import StatCard from '../components/StatCard';

interface DailyReport {
  total_sales: number;
  total_revenue: number;
  total_expenses: number;
  profit: number;
  shifts_closed: number;
}
interface MonthlyReport {
  total_sales: number;
  total_revenue: number;
  total_expenses: number;
  profit: number;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function monthStr() {
  return new Date().toISOString().slice(0, 7);
}

export default function ReportsPage() {
  const t = useT();
  const [tab, setTab] = useState<'daily' | 'monthly'>('daily');
  const [date, setDate] = useState(todayStr());
  const [month, setMonth] = useState(monthStr());
  const [daily, setDaily] = useState<DailyReport | null>(null);
  const [monthly, setMonthly] = useState<MonthlyReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (tab === 'daily') {
      get<DailyReport>(`/reports/daily?date=${date}`)
        .then(setDaily)
        .catch((err) => setError(err instanceof ApiError ? err.message : t.reports.loadFailed));
    } else {
      get<MonthlyReport>(`/reports/monthly?month=${month}`)
        .then(setMonthly)
        .catch((err) => setError(err instanceof ApiError ? err.message : t.reports.loadFailed));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, date, month]);

  const report = tab === 'daily' ? daily : monthly;

  return (
    <div>
      <PageHeader title={t.reports.title} subtitle={t.reports.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="tabs">
        <button className={`tab-btn${tab === 'daily' ? ' active' : ''}`} onClick={() => setTab('daily')}>
          {t.reports.daily}
        </button>
        <button className={`tab-btn${tab === 'monthly' ? ' active' : ''}`} onClick={() => setTab('monthly')}>
          {t.reports.monthly}
        </button>
      </div>

      <div className="card">
        {tab === 'daily' ? (
          <div className="field" style={{ maxWidth: 200 }}>
            <label>{t.reports.date}</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        ) : (
          <div className="field" style={{ maxWidth: 200 }}>
            <label>{t.reports.month}</label>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
        )}
      </div>

      {report && (
        <div className="stat-grid">
          <StatCard label={t.reports.sales} value={report.total_sales} color="blue" />
          <StatCard label={t.reports.revenue} value={`${Number(report.total_revenue).toFixed(3)} KD`} color="green" />
          <StatCard label={t.reports.expenses} value={`${Number(report.total_expenses).toFixed(3)} KD`} color="red" />
          <StatCard
            label={t.reports.profit}
            value={`${Number(report.profit).toFixed(3)} KD`}
            color={report.profit >= 0 ? 'green' : 'red'}
          />
          {'shifts_closed' in report && <StatCard label={t.reports.shiftsClosed} value={(report as DailyReport).shifts_closed} />}
        </div>
      )}
    </div>
  );
}
