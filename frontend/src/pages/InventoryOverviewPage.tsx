import { FormEvent, useEffect, useState } from 'react';
import { get, post, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';

interface LocationStock {
  location_id: string;
  location_name: string;
  location_type: 'kiosk' | 'warehouse';
  qty: number;
}

interface MaterialStock {
  raw_material_id: string;
  name: string;
  name_en: string | null;
  category: string | null;
  package_unit: string | null;
  min_stock_qty: number | null;
  total_qty: number;
  by_location: LocationStock[];
  low_stock: boolean;
}

interface Location {
  id: string;
  name: string;
  type: 'kiosk' | 'warehouse';
}

interface Adjustment {
  id: string;
  raw_material_id: string;
  raw_material_name: string;
  raw_material_name_en: string | null;
  location_id: string;
  location_name: string;
  qty_delta: number;
  reason: string;
  created_by_name: string | null;
  created_at: string;
}

function fmtQty(n: number): string {
  return String(parseFloat(n.toFixed(3)));
}

export default function InventoryOverviewPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const [materials, setMaterials] = useState<MaterialStock[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<Adjustment[]>([]);

  const [adjustTarget, setAdjustTarget] = useState<MaterialStock | null>(null);
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [adjustLocationId, setAdjustLocationId] = useState('');
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustLoading, setAdjustLoading] = useState(false);

  function load() {
    get<{ materials: MaterialStock[] }>('/inventory/overview')
      .then((r) => setMaterials(r.materials))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.inventory.loadFailed));
  }

  function loadHistory() {
    get<{ adjustments: Adjustment[] }>('/inventory/adjustments')
      .then((r) => setHistory(r.adjustments))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.inventory.historyLoadFailed));
  }

  useEffect(() => {
    load();
    get<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function materialLabel(m: { name: string; name_en: string | null }) {
    return (lang === 'en' && m.name_en) || m.name;
  }

  function openAdjust(m: MaterialStock) {
    setAdjustTarget(m);
    setDirection('add');
    setAdjustLocationId(m.by_location[0]?.location_id || '');
    setAdjustQty('');
    setAdjustReason('');
  }

  async function handleAdjustSubmit(e: FormEvent) {
    e.preventDefault();
    if (!adjustTarget) return;
    setError(null);
    setAdjustLoading(true);
    try {
      const qty = Number(adjustQty);
      await post('/inventory/adjustments', {
        raw_material_id: adjustTarget.raw_material_id,
        location_id: adjustLocationId,
        qty_delta: direction === 'add' ? qty : -qty,
        reason: adjustReason,
      });
      setAdjustTarget(null);
      load();
      if (showHistory) loadHistory();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.inventory.adjustFailed);
    } finally {
      setAdjustLoading(false);
    }
  }

  function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next) loadHistory();
  }

  const lowStockCount = materials.filter((m) => m.low_stock).length;

  return (
    <div>
      <PageHeader title={t.inventory.title} subtitle={t.inventory.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      {lowStockCount > 0 && (
        <div style={{ padding: '12px', backgroundColor: '#ffe6e6', borderLeft: '4px solid #e74c3c', marginBottom: '16px', borderRadius: '4px' }}>
          <strong>{t.inventory.lowStockAlert(lowStockCount)}</strong>
        </div>
      )}

      <div className="section-title-row">
        <span className="muted">{t.inventory.total(materials.length)}</span>
        <button className="btn btn-secondary btn-sm" onClick={toggleHistory}>
          {t.inventory.toggleHistory}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.inventory.material}</th>
                <th className="num">{t.inventory.totalStock}</th>
                <th>{t.inventory.byLocation}</th>
                <th>{t.inventory.status}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.raw_material_id}>
                  <td style={{ fontWeight: 700 }}>
                    {materialLabel(m)}
                    <div className="muted" style={{ fontWeight: 400, fontSize: 11 }}>
                      {m.min_stock_qty !== null ? t.inventory.reorderPoint(fmtQty(Number(m.min_stock_qty))) : t.inventory.noThreshold}
                    </div>
                  </td>
                  <td className="num">{fmtQty(m.total_qty)} {m.package_unit || ''}</td>
                  <td>
                    {m.by_location.length === 0 ? (
                      '—'
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {m.by_location.map((l) => (
                          <span key={l.location_id} className="tag gray" style={{ fontWeight: 600 }}>
                            {l.location_name}: {fmtQty(l.qty)}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    {m.total_qty <= 0 ? (
                      <Tag color="red">{t.inventory.statusOut}</Tag>
                    ) : m.low_stock ? (
                      <Tag color="amber">{t.inventory.statusLow}</Tag>
                    ) : (
                      <Tag color="green">{t.inventory.statusOk}</Tag>
                    )}
                  </td>
                  <td>
                    <button className="btn btn-sm" onClick={() => openAdjust(m)}>
                      {t.inventory.adjustStock}
                    </button>
                  </td>
                </tr>
              ))}
              {materials.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">{t.inventory.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showHistory && (
        <div className="card">
          <div className="card-head">
            <h2>{t.inventory.historyTitle}</h2>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td style={{ fontWeight: 700 }}>{materialLabel({ name: h.raw_material_name, name_en: h.raw_material_name_en })}</td>
                    <td>{h.location_name}</td>
                    <td className="num" style={{ color: h.qty_delta < 0 ? '#e74c3c' : '#27ae60' }}>
                      {h.qty_delta > 0 ? '+' : ''}{fmtQty(h.qty_delta)}
                    </td>
                    <td>{h.reason}</td>
                    <td className="muted">{h.created_by_name || '—'}</td>
                    <td className="muted">{new Date(h.created_at).toLocaleString(lang === 'ar' ? 'ar-KW' : 'en-GB')}</td>
                  </tr>
                ))}
                {history.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty-state">{t.inventory.historyEmpty}</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {adjustTarget && (
        <Modal
          title={t.inventory.adjustTitle}
          onClose={() => setAdjustTarget(null)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="adjust-form" disabled={adjustLoading || !adjustLocationId}>
                {adjustLoading ? t.common.loading : t.inventory.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.inventory.cancel}
              </button>
            </>
          )}
        >
          <form id="adjust-form" onSubmit={handleAdjustSubmit} className="field-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{materialLabel(adjustTarget)}</label>
            </div>
            <div className="field">
              <label>{t.inventory.adjustDirection}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['add', 'remove'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDirection(d)}
                    className={`btn btn-sm ${direction === d ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ flex: 1, justifyContent: 'center' }}
                  >
                    {d === 'add' ? t.inventory.adjustAdd : t.inventory.adjustRemove}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>{t.inventory.adjustLocation}</label>
              <select value={adjustLocationId} onChange={(e) => setAdjustLocationId(e.target.value)} required>
                <option value="">{t.inventory.selectLocation}</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.inventory.adjustQty}</label>
              <input type="number" step="0.001" min={0.001} value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} required />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.inventory.adjustReason}</label>
              <input value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder={t.inventory.adjustReasonPlaceholder} required />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
