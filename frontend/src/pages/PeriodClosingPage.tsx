import { useEffect, useState } from 'react';
import { get, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import ConfirmDialog from '../components/ConfirmDialog';
import ClosePeriodModal from '../components/ClosePeriodModal';
import { IconPlus, IconTrash } from '../components/Icon';

export interface ClosedPeriod {
  id: string;
  period_year: number;
  period_month: number;
  closed_by: string | null;
  closed_by_name: string | null;
  closed_at: string;
}

// Period Closing module (MIGRATION_053) — Settings > Setup > Period closing.
// Same Table + Modal + ConfirmDialog shape as ProjectsPage.tsx, minus the
// edit action -- a closed period is never edited, only closed or reopened
// (deleted), so each row only ever gets the one destructive "reopen" action.
export default function PeriodClosingPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);

  const MONTH_LABELS = [
    t.periodClosing.month1,
    t.periodClosing.month2,
    t.periodClosing.month3,
    t.periodClosing.month4,
    t.periodClosing.month5,
    t.periodClosing.month6,
    t.periodClosing.month7,
    t.periodClosing.month8,
    t.periodClosing.month9,
    t.periodClosing.month10,
    t.periodClosing.month11,
    t.periodClosing.month12,
  ];

  const [items, setItems] = useState<ClosedPeriod[]>([]);
  const [open, setOpen] = useState(false);
  const [confirmReopenId, setConfirmReopenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    get<{ closedPeriods: ClosedPeriod[] }>('/period-closing')
      .then((r) => setItems(r.closedPeriods))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.periodClosing.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  function formatDate(d: string) {
    return new Date(d).toLocaleString(lang === 'ar' ? 'ar-KW' : 'en-GB');
  }

  async function handleReopen() {
    const id = confirmReopenId;
    setConfirmReopenId(null);
    if (!id) return;
    setError(null);
    try {
      await del(`/period-closing/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.periodClosing.reopenFailed);
    }
  }

  return (
    <div>
      <PageHeader title={t.periodClosing.title} subtitle={t.periodClosing.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.periodClosing.count(items.length)}</span>
        <button className="btn btn-danger btn-sm" onClick={() => setOpen(true)}>
          <IconPlus /> {t.periodClosing.closeItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.periodClosing.year}</th>
                <th>{t.periodClosing.month}</th>
                <th>{t.periodClosing.closedBy}</th>
                <th>{t.periodClosing.closedAt}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((cp) => (
                <tr key={cp.id}>
                  <td style={{ fontWeight: 700 }}>{cp.period_year}</td>
                  <td>{MONTH_LABELS[cp.period_month - 1] || cp.period_month}</td>
                  <td>{cp.closed_by_name || '—'}</td>
                  <td>{formatDate(cp.closed_at)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="icon-btn" title={t.periodClosing.reopenAction} onClick={() => setConfirmReopenId(cp.id)}>
                      <IconTrash />
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">{t.periodClosing.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && <ClosePeriodModal onClose={() => setOpen(false)} onSaved={load} />}

      {confirmReopenId && (
        <ConfirmDialog message={t.periodClosing.reopenConfirm} onConfirm={handleReopen} onCancel={() => setConfirmReopenId(null)} />
      )}
    </div>
  );
}
