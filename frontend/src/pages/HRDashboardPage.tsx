import { useEffect, useMemo } from 'react';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import StatCard from '../components/StatCard';
import Tag from '../components/Tag';
import { usePerformanceStore, OKRStatus } from '../store/usePerformanceStore';
import { useSLAStore } from '../store/useSLAStore';

const OKR_STATUS_ORDER: OKRStatus[] = ['active', 'draft', 'completed', 'cancelled'];

export default function HRDashboardPage() {
  const t = useT();
  const objectives = usePerformanceStore((s) => s.objectives);
  const requests = usePerformanceStore((s) => s.requests);
  const fetchObjectives = usePerformanceStore((s) => s.fetchObjectives);
  const fetchRequests = usePerformanceStore((s) => s.fetchRequests);
  const summary = useSLAStore((s) => s.summary);
  const fetchSlaReport = useSLAStore((s) => s.fetchSlaReport);
  const slaError = useSLAStore((s) => s.error);
  const perfError = usePerformanceStore((s) => s.error);

  useEffect(() => {
    fetchObjectives();
    fetchRequests();
    fetchSlaReport();
  }, [fetchObjectives, fetchRequests, fetchSlaReport]);

  const totalBreaches = useMemo(
    () => summary.reduce((sum, row) => sum + row.response_breached + row.resolution_breached, 0),
    [summary]
  );
  const breachedRows = useMemo(
    () => summary.filter((row) => row.response_breached > 0 || row.resolution_breached > 0),
    [summary]
  );
  const pendingRequests = useMemo(() => requests.filter((r) => r.status !== 'submitted'), [requests]);
  const activeObjectives = useMemo(() => objectives.filter((o) => o.status === 'active'), [objectives]);
  const avgProgress = useMemo(() => {
    if (activeObjectives.length === 0) return 0;
    return Math.round(activeObjectives.reduce((sum, o) => sum + Number(o.progress_pct || 0), 0) / activeObjectives.length);
  }, [activeObjectives]);
  const byStatus = useMemo(() => {
    const map = new Map<OKRStatus, { count: number; avg: number }>();
    for (const status of OKR_STATUS_ORDER) map.set(status, { count: 0, avg: 0 });
    for (const o of objectives) {
      const entry = map.get(o.status) ?? { count: 0, avg: 0 };
      entry.count += 1;
      entry.avg += Number(o.progress_pct || 0);
      map.set(o.status, entry);
    }
    return OKR_STATUS_ORDER.map((status) => {
      const entry = map.get(status)!;
      return { status, count: entry.count, avg: entry.count > 0 ? Math.round(entry.avg / entry.count) : 0 };
    });
  }, [objectives]);

  function statusLabel(status: OKRStatus) {
    return status === 'draft'
      ? t.performance.statusDraft
      : status === 'active'
        ? t.performance.statusActive
        : status === 'completed'
          ? t.performance.statusCompleted
          : t.performance.statusCancelled;
  }

  return (
    <div>
      <PageHeader title={t.hrDashboard.title} subtitle={t.hrDashboard.subtitle} />
      {(slaError || perfError) && <div className="error-banner">{slaError || perfError}</div>}

      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <StatCard label={t.hrDashboard.statSlaBreaches} value={String(totalBreaches)} color={totalBreaches > 0 ? 'red' : 'green'} />
        <StatCard
          label={t.hrDashboard.statPendingFeedback}
          value={String(pendingRequests.length)}
          color={pendingRequests.length > 0 ? 'amber' : 'green'}
        />
        <StatCard label={t.hrDashboard.statAvgOkrProgress} value={`${avgProgress}%`} color="blue" />
        <StatCard label={t.hrDashboard.statActiveObjectives} value={String(activeObjectives.length)} />
      </div>

      <div className="card">
        <div className="section-title-row">
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.hrDashboard.slaAlertsTitle}</span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.hrDashboard.colCategory}</th>
                <th>{t.hrDashboard.colPriority}</th>
                <th>{t.hrDashboard.colStatus}</th>
                <th className="num">{t.hrDashboard.colTotal}</th>
                <th className="num">{t.hrDashboard.colResponseBreached}</th>
                <th className="num">{t.hrDashboard.colResolutionBreached}</th>
                <th className="num">{t.hrDashboard.colEscalated}</th>
              </tr>
            </thead>
            <tbody>
              {breachedRows.map((row, i) => (
                <tr key={i}>
                  <td>{row.category}</td>
                  <td>{row.priority}</td>
                  <td>{row.status}</td>
                  <td className="num">{row.total}</td>
                  <td className="num" style={{ color: row.response_breached > 0 ? 'var(--red-600)' : undefined }}>{row.response_breached}</td>
                  <td className="num" style={{ color: row.resolution_breached > 0 ? 'var(--red-600)' : undefined }}>{row.resolution_breached}</td>
                  <td className="num">{row.escalated}</td>
                </tr>
              ))}
              {breachedRows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">{t.hrDashboard.slaAlertsEmpty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="section-title-row">
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.hrDashboard.okrProgressTitle}</span>
        </div>
        <div className="stat-grid">
          {byStatus.map(({ status, count, avg }) => (
            <div key={status} className="stat-card">
              <div className="stat-label">
                {statusLabel(status)} <Tag color="gray">{count}</Tag>
              </div>
              <div className="stat-value num">{avg}%</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="section-title-row">
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.hrDashboard.feedbackPendingTitle}</span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.hrDashboard.colSubject}</th>
                <th>{t.hrDashboard.colReviewer}</th>
                <th>{t.hrDashboard.colCycle}</th>
                <th>{t.hrDashboard.colType}</th>
              </tr>
            </thead>
            <tbody>
              {pendingRequests.map((r) => (
                <tr key={r.id}>
                  <td>{r.subject_name || r.subject_employee_id}</td>
                  <td>{r.reviewer_name || r.reviewer_employee_id}</td>
                  <td>{r.cycle_name || r.cycle_id}</td>
                  <td>{r.reviewer_type}</td>
                </tr>
              ))}
              {pendingRequests.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <div className="empty-state">{t.hrDashboard.feedbackPendingEmpty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
