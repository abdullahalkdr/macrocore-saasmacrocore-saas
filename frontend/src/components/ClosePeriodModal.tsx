import { FormEvent, useState } from 'react';
import { post, ApiError } from '../api/client';
import { useT } from '../i18n';
import Modal from './Modal';

// Period Closing module (MIGRATION_053). Unlike CostCenterModal.tsx /
// ProjectModal.tsx this never edits an existing row -- a closed_periods row
// is only ever created (close) or deleted (reopen, handled directly from
// PeriodClosingPage.tsx's row action), so there's no `period` prop and no
// patch() branch. Year/month are plain number inputs rather than a native
// <input type="month"> -- keeps the two fields independently validatable
// against the same 2000-2100 / 1-12 ranges the backend enforces.
interface ClosePeriodModalProps {
  onClose: () => void;
  onSaved: () => void;
}

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

export default function ClosePeriodModal({ onClose, onSaved }: ClosePeriodModalProps) {
  const t = useT();

  const now = new Date();
  const [periodYear, setPeriodYear] = useState(String(now.getFullYear()));
  const [periodMonth, setPeriodMonth] = useState(String(now.getMonth() + 1));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const year = Number(periodYear);
    const month = Number(periodMonth);
    if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
      setError(t.periodClosing.invalidYear);
      return;
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      setError(t.periodClosing.invalidMonth);
      return;
    }

    setLoading(true);
    try {
      await post('/period-closing', { period_year: year, period_month: month });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.periodClosing.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      title={t.periodClosing.closeItem}
      onClose={onClose}
      actions={(requestClose) => (
        <>
          <button className="btn btn-danger" type="submit" form="close-period-form" disabled={loading}>
            {loading ? t.common.loading : t.periodClosing.closeAction}
          </button>
          <button className="btn btn-secondary" type="button" onClick={requestClose}>
            {t.common.cancel}
          </button>
        </>
      )}
    >
      {error && (
        <div className="error-banner" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{t.periodClosing.closeWarning}</p>

      <form id="close-period-form" onSubmit={handleSubmit} className="field-grid">
        <div className="field">
          <label>{t.periodClosing.year}</label>
          <input
            type="number"
            min={MIN_YEAR}
            max={MAX_YEAR}
            value={periodYear}
            onChange={(e) => setPeriodYear(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="field">
          <label>{t.periodClosing.month}</label>
          <select value={periodMonth} onChange={(e) => setPeriodMonth(e.target.value)}>
            {MONTH_LABELS.map((label, i) => (
              <option key={i + 1} value={i + 1}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </form>
    </Modal>
  );
}
