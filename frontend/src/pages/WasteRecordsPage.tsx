import { FormEvent, useEffect, useState } from 'react';
import { get, post, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { IconPlus } from '../components/Icon';

interface WasteRecord {
  id: string;
  shift_id: string;
  product_id: string;
  qty: number;
  created_at: string;
}
interface Product {
  id: string;
  name: string;
}
interface Shift {
  id: string;
  status: string;
  opened_at: string;
}

export default function WasteRecordsPage() {
  const t = useT();
  const [items, setItems] = useState<WasteRecord[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [open, setOpen] = useState(false);
  const [shiftId, setShiftId] = useState('');
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    get<{ waste_records: WasteRecord[] }>('/waste-records')
      .then((r) => setItems(r.waste_records))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.waste.loadFailed));
  }

  useEffect(() => {
    load();
    get<{ products: Product[] }>('/products').then((r) => setProducts(r.products)).catch(() => {});
    get<{ shifts: Shift[] }>('/shifts?limit=20').then((r) => setShifts(r.shifts)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const productName = (id: string) => products.find((p) => p.id === id)?.name || id;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await post('/waste-records', { shift_id: shiftId, product_id: productId, qty: Number(qty) });
      setQty('');
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.waste.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader title={t.waste.title} subtitle={t.waste.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.waste.count(items.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          <IconPlus /> {t.waste.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.reports.date}</th>
                <th>{t.waste.product}</th>
                <th className="num">{t.waste.qty}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((w) => (
                <tr key={w.id}>
                  <td>{new Date(w.created_at).toLocaleString()}</td>
                  <td style={{ fontWeight: 700 }}>{productName(w.product_id)}</td>
                  <td className="num">{w.qty}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={3}>
                    <div className="empty-state">{t.waste.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={t.waste.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="waste-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                {t.common.cancel}
              </button>
            </>
          }
        >
          <form id="waste-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.waste.shift}</label>
              <select value={shiftId} onChange={(e) => setShiftId(e.target.value)} required>
                <option value="">{t.waste.selectShift}</option>
                {shifts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {new Date(s.opened_at).toLocaleString()} ({s.status})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.waste.product}</label>
              <select value={productId} onChange={(e) => setProductId(e.target.value)} required>
                <option value="">{t.waste.selectProduct}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.waste.qty}</label>
              <input type="number" step="0.001" value={qty} onChange={(e) => setQty(e.target.value)} required />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
