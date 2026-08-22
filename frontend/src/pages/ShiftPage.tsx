import { useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import { IconPlus, IconEdit, IconTrash } from '../components/Icon';

const CHANNELS = ['cash', 'knet', 'jahez', 'vthru'];
const DELIVERY_CHANNELS = ['jahez', 'vthru'];
// Matches backend CASH_DENOMINATIONS in shifts.controller.ts — keep in sync.
const CASH_DENOMINATIONS = [20, 10, 5, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.005];

interface Product {
  id: string;
  name: string;
  name_en: string | null;
  sell_price: number | null;
  has_sizes: boolean;
}

interface Location {
  id: string;
  name: string;
  type: 'kiosk' | 'warehouse';
}

interface Employee {
  id: string;
  name: string;
}

interface ProductSize {
  id: string;
  name: string;
  name_en: string | null;
  sell_price: number | null;
}

interface Assignment {
  id: string;
  product_id: string;
  product_size_id: string | null;
  assigned_qty: number;
  remaining_qty: number;
  actual_remaining_qty: number | null;
}

interface CashDenominationRow {
  denomination: number;
  count: number;
  total: number;
}

interface ShiftListItem {
  id: string;
  employee_id: string | null;
  employee_name: string | null;
  location_id: string | null;
  location_name: string | null;
  date: string;
  opened_at: string;
  closed_at: string | null;
  status: string;
  closing_notes: string | null;
  total_cash_sales?: number;
  counted_cash?: number;
  is_match: boolean | null;
}

interface ShiftDetail {
  shift: ShiftListItem;
  assignments: Assignment[];
  total_sales: number;
  total_revenue: number;
  total_cash_sales: number;
  cash_denominations: CashDenominationRow[];
  counted_cash: number;
  is_match: boolean | null;
}

type ReconMode = 'close' | 'edit' | 'view';

export default function ShiftPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const user = useAuthStore((s) => s.user);
  const isManager = user?.role === 'admin' || user?.role === 'manager';

  const [products, setProducts] = useState<Product[]>([]);
  const [sizesByProduct, setSizesByProduct] = useState<Record<string, ProductSize[]>>({});
  const [locations, setLocations] = useState<Location[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [view, setView] = useState<'hub' | 'sell'>('hub');
  const [openShifts, setOpenShifts] = useState<ShiftListItem[]>([]);
  const [closedShifts, setClosedShifts] = useState<ShiftListItem[]>([]);

  const [activeShiftId, setActiveShiftId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShiftDetail | null>(null);
  const [channel, setChannel] = useState('cash');
  const [commissionPct, setCommissionPct] = useState('');

  const [startOpen, setStartOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [assignQty, setAssignQty] = useState<Record<string, string>>({});
  const [startLoading, setStartLoading] = useState(false);

  const [reconTarget, setReconTarget] = useState<{ shiftId: string; mode: ReconMode } | null>(null);
  const [reconDetail, setReconDetail] = useState<ShiftDetail | null>(null);
  const [cashCounts, setCashCounts] = useState<Record<string, string>>({});
  const [productCounts, setProductCounts] = useState<Record<string, string>>({});
  const [closingNotes, setClosingNotes] = useState('');
  const [reconLoading, setReconLoading] = useState(false);
  const [reconError, setReconError] = useState<string | null>(null);

  const channelLabel: Record<string, string> = {
    cash: t.shift.channelCash,
    knet: t.shift.channelKnet,
    jahez: t.shift.channelJahez,
    vthru: t.shift.channelVthru,
  };

  useEffect(() => {
    get<{ products: Product[] }>('/products').then((r) => {
      setProducts(r.products);
      const sizedProducts = r.products.filter((p) => p.has_sizes);
      sizedProducts.forEach((p) => {
        get<{ sizes: ProductSize[] }>(`/products/${p.id}`)
          .then((res) => setSizesByProduct((prev) => ({ ...prev, [p.id]: res.sizes || [] })))
          .catch(() => {});
      });
    }).catch(() => {});
    // Only kiosk-type locations can host a selling shift — a warehouse holds stock but
    // doesn't sell. Inventory now lives per-location (see raw_material_batches), so the
    // shift's location determines which batches sales/waste consume from.
    get<{ locations: Location[] }>('/locations').then((r) => {
      const kiosks = r.locations.filter((l) => l.type === 'kiosk');
      setLocations(kiosks);
      if (kiosks.length === 1) setLocationId(kiosks[0].id);
    }).catch(() => {});
    get<{ employees: Employee[] }>('/employees').then((r) => setEmployees(r.employees)).catch(() => {});
    loadHub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadHub() {
    get<{ shifts: ShiftListItem[] }>('/shifts?status=open&limit=50').then((r) => setOpenShifts(r.shifts)).catch(() => {});
    get<{ shifts: ShiftListItem[] }>('/shifts?status=closed&limit=50').then((r) => setClosedShifts(r.shifts)).catch(() => {});
  }

  function loadShiftDetail(id: string) {
    return get<ShiftDetail>(`/shifts/${id}`).then(setDetail).catch((err) => {
      setError(err instanceof ApiError ? err.message : t.shift.loadFailed);
    });
  }

  async function enterSell(id: string) {
    setError(null);
    setActiveShiftId(id);
    await loadShiftDetail(id);
    setView('sell');
  }

  function backToHub() {
    setView('hub');
    setActiveShiftId(null);
    setDetail(null);
    loadHub();
  }

  async function openShift() {
    setError(null);
    setStartLoading(true);
    try {
      const assignments: { product_id: string; product_size_id?: string; assigned_qty: number }[] = [];
      for (const p of products) {
        if (p.has_sizes) {
          for (const s of sizesByProduct[p.id] || []) {
            const qty = Number(assignQty[s.id] || 0);
            if (qty > 0) assignments.push({ product_id: p.id, product_size_id: s.id, assigned_qty: qty });
          }
        } else {
          const qty = Number(assignQty[p.id] || 0);
          if (qty > 0) assignments.push({ product_id: p.id, assigned_qty: qty });
        }
      }
      const res = await post<{ shift: { id: string } }>('/shifts', {
        employee_id: employeeId || undefined,
        location_id: locationId || undefined,
        assignments,
      });
      setStartOpen(false);
      setAssignQty({});
      setEmployeeId('');
      await enterSell(res.shift.id);
      loadHub();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.shift.openFailed);
    } finally {
      setStartLoading(false);
    }
  }

  async function sell(a: Assignment) {
    if (!activeShiftId) return;
    setError(null);
    try {
      const isDelivery = DELIVERY_CHANNELS.includes(channel);
      await post('/sales', {
        shift_id: activeShiftId,
        product_id: a.product_id,
        product_size_id: a.product_size_id ?? undefined,
        qty: 1,
        payment_method: channel,
        app_commission_pct: isDelivery && isManager && commissionPct ? Number(commissionPct) : undefined,
      });
      loadShiftDetail(activeShiftId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.shift.saleFailed);
    }
  }

  function productLabel(p: Product): string {
    return lang === 'en' && p.name_en ? p.name_en : p.name;
  }
  function sizeLabel(size: ProductSize): string {
    return lang === 'en' && size.name_en ? size.name_en : size.name;
  }
  const productNames = Object.fromEntries(products.map((p) => [p.id, productLabel(p)]));
  function assignmentLabel(a: { product_id: string; product_size_id: string | null }): string {
    const productName = productNames[a.product_id] || a.product_id;
    if (!a.product_size_id) return productName;
    const size = (sizesByProduct[a.product_id] || []).find((s) => s.id === a.product_size_id);
    return size ? `${productName} - ${sizeLabel(size)}` : productName;
  }

  function denomLabel(d: number): string {
    return d >= 1 ? `${d} ${t.shift.kd}` : `${Math.round(d * 1000)} ${t.shift.fils}`;
  }

  function fmtDateTime(v: string | null): string {
    return v ? new Date(v).toLocaleString(lang === 'ar' ? 'ar-KW' : undefined) : '—';
  }

  async function openRecon(shiftId: string, mode: ReconMode) {
    setReconError(null);
    try {
      const d = await get<ShiftDetail>(`/shifts/${shiftId}`);
      setReconDetail(d);

      const pc: Record<string, string> = {};
      for (const a of d.assignments) {
        pc[a.id] = a.actual_remaining_qty !== null && a.actual_remaining_qty !== undefined ? String(a.actual_remaining_qty) : String(a.remaining_qty);
      }
      setProductCounts(pc);

      const cc: Record<string, string> = {};
      for (const denom of CASH_DENOMINATIONS) {
        const existing = d.cash_denominations.find((r) => Number(r.denomination) === denom);
        cc[String(denom)] = existing ? String(existing.count) : '0';
      }
      setCashCounts(cc);

      setClosingNotes(d.shift.closing_notes || '');
      setReconTarget({ shiftId, mode });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.shift.loadFailed);
    }
  }

  const reconComplete =
    !!reconDetail &&
    reconDetail.assignments.every((a) => {
      const v = Number(productCounts[a.id]);
      return productCounts[a.id] !== undefined && productCounts[a.id] !== '' && !isNaN(v) && v >= 0;
    }) &&
    CASH_DENOMINATIONS.every((d) => {
      const v = Number(cashCounts[String(d)]);
      return cashCounts[String(d)] !== undefined && cashCounts[String(d)] !== '' && Number.isInteger(v) && v >= 0;
    });

  const countedCashLive = CASH_DENOMINATIONS.reduce((sum, d) => sum + d * (Number(cashCounts[String(d)]) || 0), 0);
  const expectedCashLive = reconDetail?.total_cash_sales ?? 0;
  const matchLive = Math.abs(countedCashLive - expectedCashLive) <= 0.005; // keep in sync with backend CASH_TOLERANCE

  async function submitRecon() {
    if (!reconTarget || !reconDetail || !reconComplete) return;
    setReconLoading(true);
    setReconError(null);
    try {
      const cash_counts = CASH_DENOMINATIONS.map((d) => ({ denomination: d, count: Number(cashCounts[String(d)] || 0) }));
      const product_counts = reconDetail.assignments.map((a) => ({
        shift_assignment_id: a.id,
        actual_remaining_qty: Number(productCounts[a.id] || 0),
      }));
      const payload = { cash_counts, product_counts, closing_notes: closingNotes || undefined };

      if (reconTarget.mode === 'close') {
        const res = await patch<ShiftDetail>(`/shifts/${reconTarget.shiftId}`, payload);
        setNotice(t.shift.closedNotice(res.total_sales, Number(res.total_revenue).toFixed(3)));
        setReconTarget(null);
        backToHub();
      } else {
        await patch(`/shifts/${reconTarget.shiftId}/reconciliation`, payload);
        setReconTarget(null);
        loadHub();
      }
    } catch (err) {
      setReconError(err instanceof ApiError ? err.message : t.shift.closeFailed);
    } finally {
      setReconLoading(false);
    }
  }

  async function handleDeleteShift(id: string) {
    if (!confirm(t.shift.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/shifts/${id}`);
      loadHub();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.shift.deleteFailed);
    }
  }

  // ---------- SELL VIEW ----------
  if (view === 'sell' && detail) {
    return (
      <div>
        <PageHeader title={t.shift.shiftOpenTitle} subtitle={t.shift.shiftOpenSubtitle} />
        <div style={{ marginTop: -14, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Tag color="green">{t.shift.tagOpen}</Tag>
          <span className="muted">
            {detail.shift.employee_name || '—'} — {detail.shift.location_name || '—'}
          </span>
          <button className="btn btn-secondary btn-sm" onClick={backToHub} style={{ marginInlineStart: 'auto' }}>
            {t.shift.backToHub}
          </button>
        </div>
        {error && <div className="error-banner">{error}</div>}

        <div className="stat-grid" style={{ marginBottom: 18 }}>
          <div className="stat-card blue">
            <div className="stat-label">{t.shift.salesSoFar}</div>
            <div className="stat-value">{detail.total_sales}</div>
          </div>
          <div className="stat-card green">
            <div className="stat-label">{t.shift.revenue}</div>
            <div className="stat-value">{Number(detail.total_revenue).toFixed(3)} KD</div>
          </div>
        </div>

        <div className="card">
          <button className="btn btn-danger" onClick={() => openRecon(detail.shift.id, 'close')}>
            {t.shift.closeShift}
          </button>
        </div>

        <div className="card">
          <div className="form-row">
            <div className="field">
              <label>{t.shift.channel}</label>
              <select
                value={channel}
                onChange={(e) => {
                  setChannel(e.target.value);
                  setCommissionPct('');
                }}
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {channelLabel[c]}
                  </option>
                ))}
              </select>
            </div>
            {DELIVERY_CHANNELS.includes(channel) && (
              <div className="field">
                <label>{t.shift.commissionPct}</label>
                {isManager ? (
                  <input
                    type="number"
                    step="0.1"
                    min={0}
                    max={100}
                    placeholder={t.shift.commissionLocked}
                    value={commissionPct}
                    onChange={(e) => setCommissionPct(e.target.value)}
                  />
                ) : (
                  <input value={t.shift.commissionLocked} disabled />
                )}
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="product-grid">
            {detail.assignments.map((a) => (
              <button
                key={a.id}
                className={`product-tile${a.remaining_qty <= 0 ? ' disabled' : ''}`}
                disabled={a.remaining_qty <= 0}
                onClick={() => sell(a)}
              >
                <div className="name">{assignmentLabel(a)}</div>
                <div className="qty">
                  {a.remaining_qty} {t.shift.left}
                </div>
              </button>
            ))}
          </div>
        </div>

        {reconTarget && reconDetail && renderReconModal()}
      </div>
    );
  }

  // ---------- HUB VIEW ----------
  function renderReconModal() {
    if (!reconTarget || !reconDetail) return null;
    const readOnly = reconTarget.mode === 'view';
    const title =
      reconTarget.mode === 'close' ? t.shift.closeReconciliationTitle : reconTarget.mode === 'edit' ? t.shift.editReconciliationTitle : t.shift.viewReconciliationTitle;

    return (
      <Modal
        title={title}
        onClose={() => setReconTarget(null)}
        actions={(requestClose) => (
          readOnly ? (
            <button className="btn btn-secondary" onClick={requestClose}>
              {t.common.cancel}
            </button>
          ) : (
            <>
              <button className="btn btn-primary" onClick={submitRecon} disabled={reconLoading || !reconComplete}>
                {reconLoading ? t.common.loading : reconTarget.mode === 'close' ? t.shift.saveClose : t.shift.saveEdit}
              </button>
              <button className="btn btn-secondary" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )
        )}
      >
        {reconError && <div className="error-banner">{reconError}</div>}
        {!readOnly && !reconComplete && <div className="error-banner">{t.shift.reconciliationIncomplete}</div>}

        <p className="muted" style={{ marginTop: 0, fontWeight: 700 }}>
          {t.shift.actualRemaining}
        </p>
        <div className="field-grid">
          {reconDetail.assignments.map((a) => (
            <div className="field" key={a.id}>
              <label>
                {assignmentLabel(a)} {t.shift.expected(a.remaining_qty)}
              </label>
              <input
                type="number"
                min={0}
                readOnly={readOnly}
                value={productCounts[a.id] ?? ''}
                onChange={(e) => setProductCounts({ ...productCounts, [a.id]: e.target.value })}
              />
            </div>
          ))}
        </div>

        <p className="muted" style={{ marginTop: 18, fontWeight: 700 }}>
          {t.shift.cashByDenomination}
        </p>
        <div className="field-grid">
          {CASH_DENOMINATIONS.map((d) => (
            <div className="field" key={d}>
              <label>{denomLabel(d)}</label>
              <input
                type="number"
                min={0}
                step={1}
                readOnly={readOnly}
                value={cashCounts[String(d)] ?? ''}
                onChange={(e) => setCashCounts({ ...cashCounts, [String(d)]: e.target.value })}
              />
            </div>
          ))}
        </div>

        <div className="stat-grid" style={{ marginTop: 16 }}>
          <div className="stat-card">
            <div className="stat-label">{t.shift.countedCash}</div>
            <div className="stat-value">{countedCashLive.toFixed(3)} KD</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t.shift.expectedCash}</div>
            <div className="stat-value">{Number(expectedCashLive).toFixed(3)} KD</div>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>{matchLive ? <Tag color="green">{t.shift.matchFull}</Tag> : <Tag color="red">{t.shift.matchMismatch}</Tag>}</div>

        <div className="field" style={{ marginTop: 16 }}>
          <label>{t.shift.closingNotes}</label>
          <textarea rows={2} readOnly={readOnly} value={closingNotes} onChange={(e) => setClosingNotes(e.target.value)} />
        </div>
      </Modal>
    );
  }

  return (
    <div>
      <PageHeader title={t.shift.hubTitle} subtitle={t.shift.hubSubtitle} />
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      <div className="section-title-row">
        <span />
        <button className="btn btn-primary btn-sm" onClick={() => setStartOpen(true)}>
          <IconPlus /> {t.shift.startNew}
        </button>
      </div>

      <div className="section-title-row">
        <span className="muted">{t.shift.openShiftsCount(openShifts.length)}</span>
      </div>
      <div className="card">
        {openShifts.length === 0 && <div className="empty-state">{t.shift.noOpenShifts}</div>}
        {openShifts.map((s) => (
          <div
            key={s.id}
            onClick={() => enterSell(s.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '10px 4px',
              borderBottom: '1px solid var(--border)',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontWeight: 700, flex: 1 }}>{s.employee_name || '—'}</div>
            <div className="muted" style={{ flex: 1 }}>
              {s.location_name || '—'}
            </div>
            <div className="muted num">{fmtDateTime(s.opened_at)}</div>
            <Tag color="green">{t.shift.tagOpen}</Tag>
          </div>
        ))}
      </div>

      <div className="section-title-row">
        <span className="muted">{t.shift.closedLog}</span>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.shift.employee}</th>
                <th>{t.shift.location}</th>
                <th>{t.shift.colOpened}</th>
                <th>{t.shift.colClosed}</th>
                <th>{t.shift.colMatch}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {closedShifts.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 700 }}>{s.employee_name || '—'}</td>
                  <td>{s.location_name || '—'}</td>
                  <td className="num">{fmtDateTime(s.opened_at)}</td>
                  <td className="num">{fmtDateTime(s.closed_at)}</td>
                  <td>{s.is_match ? <Tag color="green">{t.shift.matchYes}</Tag> : <Tag color="red">{t.shift.matchNo}</Tag>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => openRecon(s.id, 'view')}>
                      {t.shift.details}
                    </button>
                    {isManager && (
                      <>
                        <button className="icon-btn" title={t.shift.editReconciliationTitle} onClick={() => openRecon(s.id, 'edit')}>
                          <IconEdit />
                        </button>
                        <button className="icon-btn" title={t.common.delete} onClick={() => handleDeleteShift(s.id)}>
                          <IconTrash />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {closedShifts.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">{t.shift.noClosedShifts}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {startOpen && (
        <Modal
          title={t.shift.startNew}
          onClose={() => setStartOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" onClick={openShift} disabled={startLoading || products.length === 0 || !locationId}>
                {startLoading ? t.common.loading : t.shift.startAndHandoff}
              </button>
              <button className="btn btn-secondary" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          {locations.length === 0 && <div className="error-banner">{t.shift.noLocation}</div>}
          <div className="field-grid">
            <div className="field">
              <label>{t.shift.employee}</label>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">{t.shift.selectEmployee}</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.shift.location}</label>
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">{t.shift.selectLocation}</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="muted" style={{ marginTop: 14 }}>
            {t.shift.handoffTitle}
          </p>
          <div className="field-grid">
            {products.map((p) =>
              p.has_sizes ? (
                (sizesByProduct[p.id] || []).map((s) => (
                  <div className="field" key={s.id}>
                    <label>
                      {productLabel(p)} — {sizeLabel(s)}
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={assignQty[s.id] || ''}
                      onChange={(e) => setAssignQty({ ...assignQty, [s.id]: e.target.value })}
                    />
                  </div>
                ))
              ) : (
                <div className="field" key={p.id}>
                  <label>{productLabel(p)}</label>
                  <input
                    type="number"
                    min={0}
                    value={assignQty[p.id] || ''}
                    onChange={(e) => setAssignQty({ ...assignQty, [p.id]: e.target.value })}
                  />
                </div>
              )
            )}
          </div>
          {products.length === 0 && <p className="muted">{t.shift.addProductFirst}</p>}
        </Modal>
      )}

      {reconTarget && reconDetail && renderReconModal()}
    </div>
  );
}
