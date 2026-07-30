import { FormEvent, useEffect, useState } from 'react';
import { get, post, ApiError } from '../api/client';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { IconPlus } from '../components/Icon';

interface RawMaterial {
  id: string;
  name: string;
  name_en: string | null;
}

interface Location {
  id: string;
  name: string;
  type: 'kiosk' | 'warehouse';
}

interface Transfer {
  id: string;
  raw_material_id: string;
  from_location_id: string;
  to_location_id: string;
  qty: number;
  new_batch_id: string | null;
  created_at: string;
}

export default function StockTransfersPage() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [open, setOpen] = useState(false);

  const [rawMaterialId, setRawMaterialId] = useState('');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [qty, setQty] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    Promise.all([
      get<{ transfers: Transfer[] }>('/stock-transfers').then((r) => setTransfers(r.transfers)),
      get<{ raw_materials: RawMaterial[] }>('/raw-materials').then((r) => setMaterials(r.raw_materials)),
      get<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)),
    ]).catch((err) => setError(err instanceof ApiError ? err.message : 'خطأ في تحميل البيانات'));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  function materialName(id: string) {
    return materials.find((m) => m.id === id)?.name || '—';
  }
  function locationName(id: string) {
    return locations.find((l) => l.id === id)?.name || '—';
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await post('/stock-transfers', {
        raw_material_id: rawMaterialId,
        from_location_id: fromLocationId,
        to_location_id: toLocationId,
        qty: qty ? Number(qty) : undefined,
      });
      setRawMaterialId('');
      setFromLocationId('');
      setToLocationId('');
      setQty('');
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطأ في تنفيذ التحويل');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader title="تحويل المخزون" subtitle="نقل مواد خام بين المستودع والأكشاك" />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">سجل التحويلات: {transfers.length}</span>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          <IconPlus /> تحويل جديد
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>المادة الخام</th>
                <th>من</th>
                <th>إلى</th>
                <th className="num">الكمية</th>
                <th>التاريخ</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((tr) => (
                <tr key={tr.id}>
                  <td style={{ fontWeight: 700 }}>{materialName(tr.raw_material_id)}</td>
                  <td>{locationName(tr.from_location_id)}</td>
                  <td>{locationName(tr.to_location_id)}</td>
                  <td className="num">{Number(tr.qty).toFixed(3)}</td>
                  <td>{new Date(tr.created_at).toLocaleString('ar-KW')}</td>
                </tr>
              ))}
              {transfers.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">لا توجد تحويلات مسجّلة بعد</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title="تحويل جديد"
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="transfer-form" disabled={loading}>
                {loading ? 'جاري...' : 'تنفيذ التحويل'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                إلغاء
              </button>
            </>
          }
        >
          <form id="transfer-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>المادة الخام *</label>
              <select value={rawMaterialId} onChange={(e) => setRawMaterialId(e.target.value)} required>
                <option value="">اختر مادة خام</option>
                {materials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>من موقع *</label>
              <select value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)} required>
                <option value="">اختر الموقع المصدر</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.type === 'warehouse' ? 'مستودع' : 'كشك'})
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>إلى موقع *</label>
              <select value={toLocationId} onChange={(e) => setToLocationId(e.target.value)} required>
                <option value="">اختر الموقع الوجهة</option>
                {locations
                  .filter((l) => l.id !== fromLocationId)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({l.type === 'warehouse' ? 'مستودع' : 'كشك'})
                    </option>
                  ))}
              </select>
            </div>

            <div className="field">
              <label>الكمية *</label>
              <input type="number" step="0.001" value={qty} onChange={(e) => setQty(e.target.value)} required />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
