import { FormEvent, useEffect, useState } from 'react';
import { get, patch, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import { IconPlus } from '../components/Icon';

interface FixedCostItem {
  label: string;
  amount: number;
}

interface CompanySettings {
  fixed_cost_items: FixedCostItem[];
  estimated_orders_mode: 'auto' | 'manual';
  estimated_orders_manual: number | null;
  default_jahez_commission_pct: number;
  default_vthru_commission_pct: number;
  official_shift_start_time: string | null;
  grace_period_minutes: number | null;
  working_days_per_month: number | null;
  standard_shift_minutes: number | null;
}

export default function SettingsPage() {
  const t = useT();
  const [items, setItems] = useState<FixedCostItem[]>([]);
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [manualOrders, setManualOrders] = useState('');
  const [jahezPct, setJahezPct] = useState('');
  const [vthruPct, setVthruPct] = useState('');
  const [shiftStartTime, setShiftStartTime] = useState('08:00');
  const [gracePeriod, setGracePeriod] = useState('');
  const [workingDays, setWorkingDays] = useState('');
  const [shiftMinutes, setShiftMinutes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    get<CompanySettings>('/company/me')
      .then((r) => {
        setItems(Array.isArray(r.fixed_cost_items) ? r.fixed_cost_items : []);
        setMode(r.estimated_orders_mode || 'auto');
        setManualOrders(r.estimated_orders_manual !== null && r.estimated_orders_manual !== undefined ? String(r.estimated_orders_manual) : '');
        setJahezPct(r.default_jahez_commission_pct !== undefined ? String(r.default_jahez_commission_pct) : '');
        setVthruPct(r.default_vthru_commission_pct !== undefined ? String(r.default_vthru_commission_pct) : '');
        setShiftStartTime(r.official_shift_start_time ? r.official_shift_start_time.slice(0, 5) : '08:00');
        setGracePeriod(r.grace_period_minutes !== null && r.grace_period_minutes !== undefined ? String(r.grace_period_minutes) : '');
        setWorkingDays(r.working_days_per_month !== null && r.working_days_per_month !== undefined ? String(r.working_days_per_month) : '');
        setShiftMinutes(r.standard_shift_minutes !== null && r.standard_shift_minutes !== undefined ? String(r.standard_shift_minutes) : '');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t.settings.loadFailed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addItem() {
    setItems([...items, { label: '', amount: 0 }]);
  }
  function updateItem(i: number, patchObj: Partial<FixedCostItem>) {
    setItems(items.map((it, idx) => (idx === i ? { ...it, ...patchObj } : it)));
  }
  function removeItem(i: number) {
    setItems(items.filter((_, idx) => idx !== i));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      await patch('/company/me', {
        fixed_cost_items: items.filter((it) => it.label.trim()).map((it) => ({ label: it.label.trim(), amount: Number(it.amount) || 0 })),
        estimated_orders_mode: mode,
        estimated_orders_manual: manualOrders ? Number(manualOrders) : undefined,
        default_jahez_commission_pct: jahezPct ? Number(jahezPct) : undefined,
        default_vthru_commission_pct: vthruPct ? Number(vthruPct) : undefined,
        official_shift_start_time: shiftStartTime || undefined,
        grace_period_minutes: gracePeriod ? Number(gracePeriod) : undefined,
        working_days_per_month: workingDays ? Number(workingDays) : undefined,
        standard_shift_minutes: shiftMinutes ? Number(shiftMinutes) : undefined,
      });
      setSuccess(t.settings.saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.settings.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader title={t.settings.title} subtitle={t.settings.subtitle} />
      {error && <div className="error-banner">{error}</div>}
      {success && <div className="success-banner">{success}</div>}

      <form onSubmit={handleSubmit}>
        <div className="card">
          <div className="card-head">
            <h2>{t.settings.fixedCostsTitle}</h2>
          </div>
          <div className="card-body">
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
              {t.settings.fixedCostsHint}
            </p>
            {items.map((it, i) => (
              <div key={i} className="form-row" style={{ marginBottom: 8 }}>
                <div className="field" style={{ flex: 2 }}>
                  <input
                    placeholder={t.settings.itemLabel}
                    value={it.label}
                    onChange={(e) => updateItem(i, { label: e.target.value })}
                  />
                </div>
                <div className="field">
                  <input
                    type="number"
                    step="0.001"
                    placeholder={t.settings.itemAmount}
                    value={it.amount}
                    onChange={(e) => updateItem(i, { amount: Number(e.target.value) })}
                  />
                </div>
                <button className="icon-btn" type="button" onClick={() => removeItem(i)} style={{ alignSelf: 'center' }}>
                  ×
                </button>
              </div>
            ))}
            <button className="btn btn-secondary btn-sm" type="button" onClick={addItem}>
              <IconPlus /> {t.settings.addCostItem}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>{t.settings.estimatedOrdersTitle}</h2>
          </div>
          <div className="card-body">
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
              {t.settings.estimatedOrdersHint}
            </p>
            <div className="field-grid">
              <div className="field">
                <select value={mode} onChange={(e) => setMode(e.target.value as 'auto' | 'manual')}>
                  <option value="auto">{t.settings.modeAuto}</option>
                  <option value="manual">{t.settings.modeManual}</option>
                </select>
              </div>
              {mode === 'manual' && (
                <div className="field">
                  <label>{t.settings.manualOrders}</label>
                  <input type="number" min={0} value={manualOrders} onChange={(e) => setManualOrders(e.target.value)} />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>{t.settings.commissionsTitle}</h2>
          </div>
          <div className="card-body">
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
              {t.settings.commissionsHint}
            </p>
            <div className="field-grid">
              <div className="field">
                <label>{t.settings.jahezCommission}</label>
                <input type="number" step="0.1" min={0} max={100} value={jahezPct} onChange={(e) => setJahezPct(e.target.value)} />
              </div>
              <div className="field">
                <label>{t.settings.vthruCommission}</label>
                <input type="number" step="0.1" min={0} max={100} value={vthruPct} onChange={(e) => setVthruPct(e.target.value)} />
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>{t.settings.attendanceTitle}</h2>
          </div>
          <div className="card-body">
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
              {t.settings.attendanceHint}
            </p>
            <div className="field-grid">
              <div className="field">
                <label>{t.settings.shiftStartTime}</label>
                <input type="time" value={shiftStartTime} onChange={(e) => setShiftStartTime(e.target.value)} />
              </div>
              <div className="field">
                <label>{t.settings.gracePeriod}</label>
                <input type="number" min={0} value={gracePeriod} onChange={(e) => setGracePeriod(e.target.value)} />
              </div>
              <div className="field">
                <label>{t.settings.workingDaysPerMonth}</label>
                <input type="number" min={1} value={workingDays} onChange={(e) => setWorkingDays(e.target.value)} />
              </div>
              <div className="field">
                <label>{t.settings.standardShiftMinutes}</label>
                <input type="number" min={1} value={shiftMinutes} onChange={(e) => setShiftMinutes(e.target.value)} />
              </div>
            </div>
          </div>
        </div>

        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? t.common.loading : t.settings.save}
        </button>
      </form>
    </div>
  );
}
