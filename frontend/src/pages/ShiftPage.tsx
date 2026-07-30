import { useEffect, useState } from 'react';
import { get, post, patch, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import Tag from '../components/Tag';

const CHANNELS = ['cash', 'knet', 'jahez', 'vthru'];
const DELIVERY_CHANNELS = ['jahez', 'vthru'];

interface Product {
  id: string;
  name: string;
  sell_price: number | null;
  has_sizes: boolean;
}

interface Location {
  id: string;
  name: string;
  type: 'kiosk' | 'warehouse';
}

interface ProductSize {
  id: string;
  name: string;
  name_en: string | null;
  sell_price: number | null;
}

interface ShiftSummary {
  id: string;
  status: string;
  opened_at: string;
}

interface Assignment {
  id: string;
  product_id: string;
  product_size_id: string | null;
  assigned_qty: number;
  remaining_qty: number;
}

interface ShiftDetail {
  shift: ShiftSummary;
  assignments: Assignment[];
  total_sales: number;
  total_revenue: number;
}

interface ClosedSummary {
  id: string;
  status: string;
  total_sales: number;
  total_revenue: number;
}

export default function ShiftPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const user = useAuthStore((s) => s.user);
  const isManager = user?.role === 'admin' || user?.role === 'manager';
  const [products, setProducts] = useState<Product[]>([]);
  const [sizesByProduct, setSizesByProduct] = useState<Record<string, ProductSize[]>>({});
  const [detail, setDetail] = useState<ShiftDetail | null>(null);
  const [assignQty, setAssignQty] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [closedSummary, setClosedSummary] = useState<ClosedSummary | null>(null);
  const [channel, setChannel] = useState('cash');
  const [commissionPct, setCommissionPct] = useState('');
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState('');

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
    findOpenShift();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function findOpenShift() {
    get<{ shifts: ShiftSummary[] }>('/shifts?status=open&limit=1')
      .then((r) => {
        if (r.shifts[0]) loadShift(r.shifts[0].id);
      })
      .catch(() => {});
  }

  function loadShift(id: string) {
    get<ShiftDetail>(`/shifts/${id}`).then(setDetail).catch((err) => setError(err instanceof ApiError ? err.message : t.shift.loadFailed));
  }

  async function openShift() {
    setError(null);
    setLoading(true);
    setClosedSummary(null);
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
      const res = await post<{ shift: ShiftSummary }>('/shifts', { location_id: locationId || undefined, assignments });
      loadShift(res.shift.id);
      setAssignQty({});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.shift.openFailed);
    } finally {
      setLoading(false);
    }
  }

  async function sell(a: Assignment) {
    if (!detail) return;
    setError(null);
    try {
      const isDelivery = DELIVERY_CHANNELS.includes(channel);
      await post('/sales', {
        shift_id: detail.shift.id,
        product_id: a.product_id,
        product_size_id: a.product_size_id ?? undefined,
        qty: 1,
        payment_method: channel,
        app_commission_pct: isDelivery && isManager && commissionPct ? Number(commissionPct) : undefined,
      });
      loadShift(detail.shift.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.shift.saleFailed);
    }
  }

  async function closeShift() {
    if (!detail) return;
    if (!confirm(t.shift.confirmClose)) return;
    setError(null);
    try {
      const res = await patch<{ shift: ClosedSummary }>(`/shifts/${detail.shift.id}`, { status: 'closed' });
      setClosedSummary(res.shift);
      setDetail(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.shift.closeFailed);
    }
  }

  const productNames = Object.fromEntries(products.map((p) => [p.id, p.name]));

  function sizeLabel(size: ProductSize): string {
    return lang === 'en' && size.name_en ? size.name_en : size.name;
  }

  function assignmentLabel(a: Assignment): string {
    const productName = productNames[a.product_id] || a.product_id;
    if (!a.product_size_id) return productName;
    const size = (sizesByProduct[a.product_id] || []).find((s) => s.id === a.product_size_id);
    return size ? `${productName} - ${sizeLabel(size)}` : productName;
  }

  if (!detail) {
    return (
      <div>
        <PageHeader title={t.shift.openTitle} subtitle={t.shift.openSubtitle} />
        {error && <div className="error-banner">{error}</div>}
        {closedSummary && (
          <div className="success-banner">
            {t.shift.closedNotice(closedSummary.total_sales, Number(closedSummary.total_revenue).toFixed(3))}
          </div>
        )}
        <div className="card">
          {locations.length > 1 && (
            <div className="field-grid" style={{ marginBottom: 14 }}>
              <div className="field">
                <label>الموقع (كشك)</label>
                <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">اختر الكشك</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <div className="field-grid">
            {products.map((p) =>
              p.has_sizes ? (
                (sizesByProduct[p.id] || []).map((s) => (
                  <div className="field" key={s.id}>
                    <label>
                      {p.name} — {sizeLabel(s)}
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
                  <label>{p.name}</label>
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
          <button
            className="btn btn-primary"
            onClick={openShift}
            disabled={loading || products.length === 0 || (locations.length > 0 && !locationId)}
          >
            {loading ? t.common.loading : t.shift.openBtn}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={t.shift.shiftOpenTitle} subtitle={t.shift.shiftOpenSubtitle} />
      <div style={{ marginTop: -14, marginBottom: 14 }}>
        <Tag color="green">{t.shift.tagOpen}</Tag>
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
        <button className="btn btn-danger" onClick={closeShift}>
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
    </div>
  );
}
