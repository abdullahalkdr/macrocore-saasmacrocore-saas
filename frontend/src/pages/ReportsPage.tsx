import { useEffect, useState } from 'react';
import { get, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import StatCard from '../components/StatCard';

interface DailyReport {
  total_sales: number;
  total_revenue: number;
  cost_of_goods: number;
  waste_cost: number;
  total_expenses: number;
  payroll_cost: number;
  profit: number;
  shifts_closed: number;
}
interface MonthlyReport {
  total_sales: number;
  total_revenue: number;
  cost_of_goods: number;
  waste_cost: number;
  total_expenses: number;
  payroll_cost: number;
  profit: number;
}
interface RangeReport {
  total_sales: number;
  total_revenue: number;
  cost_of_goods: number;
  waste_cost: number;
  total_expenses: number;
  payroll_cost: number;
  profit: number;
  shifts_closed: number;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function monthStr() {
  return new Date().toISOString().slice(0, 7);
}

function downloadCsv(filename: string, rows: [string, string][]) {
  const csv = rows.map(([k, v]) => `${JSON.stringify(k)},${JSON.stringify(v)}`).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const t = useT();
  const [tab, setTab] = useState<'daily' | 'monthly' | 'range'>('daily');
  const [date, setDate] = useState(todayStr());
  const [month, setMonth] = useState(monthStr());
  const [fromDate, setFromDate] = useState(todayStr());
  const [toDate, setToDate] = useState(todayStr());
  const [daily, setDaily] = useState<DailyReport | null>(null);
  const [monthly, setMonthly] = useState<MonthlyReport | null>(null);
  const [rangeReport, setRangeReport] = useState<RangeReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (tab === 'daily') {
      get<DailyReport>(`/reports/daily?date=${date}`)
        .then(setDaily)
        .catch((err) => setError(err instanceof ApiError ? err.message : t.reports.loadFailed));
    } else if (tab === 'monthly') {
      get<MonthlyReport>(`/reports/monthly?month=${month}`)
        .then(setMonthly)
        .catch((err) => setError(err instanceof ApiError ? err.message : t.reports.loadFailed));
    } else {
      if (fromDate > toDate) {
        setError(t.reports.invalidRange);
        setRangeReport(null);
        return;
      }
      get<RangeReport>(`/reports/range?from=${fromDate}&to=${toDate}`)
        .then(setRangeReport)
        .catch((err) => setError(err instanceof ApiError ? err.message : t.reports.loadFailed));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, date, month, fromDate, toDate]);

  const report = tab === 'daily' ? daily : tab === 'monthly' ? monthly : rangeReport;

  function exportCurrent() {
    if (!report) return;
    const label = tab === 'daily' ? date : tab === 'monthly' ? month : `${fromDate}_${toDate}`;
    const rows: [string, string][] = [
      [t.reports.sales, String(report.total_sales)],
      [t.reports.revenue, Number(report.total_revenue).toFixed(3)],
      [t.reports.cogs, Number(report.cost_of_goods).toFixed(3)],
      [t.reports.wasteCost, Number(report.waste_cost).toFixed(3)],
      [t.reports.expenses, Number(report.total_expenses).toFixed(3)],
      [t.reports.payrollCost, Number(report.payroll_cost).toFixed(3)],
      [t.reports.profit, Number(report.profit).toFixed(3)],
    ];
    if ('shifts_closed' in report) rows.push([t.reports.shiftsClosed, String((report as DailyReport | RangeReport).shifts_closed)]);
    downloadCsv(`report_${label}.csv`, rows);
  }

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
        <button className={`tab-btn${tab === 'range' ? ' active' : ''}`} onClick={() => setTab('range')}>
          {t.reports.range}
        </button>
      </div>

      <div className="card">
        {tab === 'daily' && (
          <div className="field" style={{ maxWidth: 200 }}>
            <label>{t.reports.date}</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        )}
        {tab === 'monthly' && (
          <div className="field" style={{ maxWidth: 200 }}>
            <label>{t.reports.month}</label>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
        )}
        {tab === 'range' && (
          <div className="form-row">
            <div className="field" style={{ maxWidth: 200 }}>
              <label>{t.reports.from}</label>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div className="field" style={{ maxWidth: 200 }}>
              <label>{t.reports.to}</label>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>
        )}
      </div>

      {report && (
        <>
          <div className="section-title-row">
            <span />
            <button className="btn btn-secondary btn-sm" onClick={exportCurrent}>
              {t.reports.exportCsv}
            </button>
          </div>
          <div className="stat-grid">
            <StatCard label={t.reports.sales} value={report.total_sales} color="blue" />
            <StatCard label={t.reports.revenue} value={`${Number(report.total_revenue).toFixed(3)} KD`} color="green" />
            <StatCard label={t.reports.cogs} value={`${Number(report.cost_of_goods).toFixed(3)} KD`} color="red" />
            <StatCard label={t.reports.wasteCost} value={`${Number(report.waste_cost).toFixed(3)} KD`} color="red" />
            <StatCard label={t.reports.expenses} value={`${Number(report.total_expenses).toFixed(3)} KD`} color="red" />
            <StatCard label={t.reports.payrollCost} value={`${Number(report.payroll_cost).toFixed(3)} KD`} color="red" />
            <StatCard
              label={t.reports.profit}
              value={`${Number(report.profit).toFixed(3)} KD`}
              color={report.profit >= 0 ? 'green' : 'red'}
            />
            {'shifts_closed' in report && (
              <StatCard label={t.reports.shiftsClosed} value={(report as DailyReport | RangeReport).shifts_closed} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
