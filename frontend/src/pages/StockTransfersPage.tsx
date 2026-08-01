import { FormEvent, useEffect, useState } from 'react';
import { get, post, del, ApiError } from '../api/client';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { IconPlus } from '../components/Icon';
import { useAuthStore } from '../store/authStore';
import { useLangStore } from '../store/langStore';
import { useT } from '../i18n';

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
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const user = useAuthStore((s) => s.user);
  const isPrivileged = user?.role === 'admin' || user?.role === 'manager';
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
    ]).catch((err) => setError(err instanceof ApiError ? err.message : t.stockTransfers.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  function materialName(id: string) {
    const m = materials.find((mm) => mm.id === id);
    return (lang === 'en' && m?.name_en) || m?.name || '—';
  }
  function locationName(id: string) {
    return locations.find((l) => l.id === id)?.name || '—';
  }

  async function handleDelete(id: string) {
    if (!window.confirm(t.stockTransfers.undoConfirm)) return;
    setError(null);
    try {
      await del(`/stock-transfers/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.stockTransfers.undoFailed);
    }
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
      setError(err instanceof ApiError ? err.message : t.stockTransfers.transferFailed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader title={t.stockTransfers.title} subtitle={t.stockTransfers.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.stockTransfers.log(transfers.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          <IconPlus /> {t.stockTransfers.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.stockTransfers.material}</th>
                <th>{t.stockTransfers.from}</th>
                <th>{t.stockTransfers.to}</th>
                <th className="num">{t.stockTransfers.qty}</th>
                <th>{t.stockTransfers.date}</th>
                {isPrivileged && <th></th>}
              </tr>
            </thead>
            <tbody>
              {transfers.map((tr) => (
                <tr key={tr.id}>
                  <td style={{ fontWeight: 700 }}>{materialName(tr.raw_material_id)}</td>
                  <td>{locationName(tr.from_location_id)}</td>
                  <td>{locationName(tr.to_location_id)}</td>
                  <td className="num">{Number(tr.qty).toFixed(3)}</td>
                  <td>{new Date(tr.created_at).toLocaleString(lang === 'ar' ? 'ar-KW' : 'en-GB')}</td>
                  {isPrivileged && (
                    <td>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDelete(tr.id)}>
                        {t.stockTransfers.undo}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {transfers.length === 0 && (
                <tr>
                  <td colSpan={isPrivileged ? 6 : 5}>
                    <div className="empty-state">{t.stockTransfers.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={t.stockTransfers.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="transfer-form" disabled={loading}>
                {loading ? t.common.loading : t.stockTransfers.execute}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                {t.stockTransfers.cancel}
              </button>
            </>
          }
        >
          <form id="transfer-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.stockTransfers.material} *</label>
              <select value={rawMaterialId} onChange={(e) => setRawMaterialId(e.target.value)} required>
                <option value="">{t.stockTransfers.selectMaterial}</option>
                {materials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {(lang === 'en' && m.name_en) || m.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>{t.stockTransfers.fromLocation} *</label>
              <select value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)} required>
                <option value="">{t.stockTransfers.selectSourceLocation}</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.type === 'warehouse' ? t.locations.typeWarehouse : t.locations.typeKiosk})
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>{t.stockTransfers.toLocation} *</label>
              <select value={toLocationId} onChange={(e) => setToLocationId(e.target.value)} required>
                <option value="">{t.stockTransfers.selectDestLocation}</option>
                {locations
                  .filter((l) => l.id !== fromLocationId)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({l.type === 'warehouse' ? t.locations.typeWarehouse : t.locations.typeKiosk})
                    </option>
                  ))}
              </select>
            </div>

            <div className="field">
              <label>{t.stockTransfers.qty} *</label>
              <input type="number" step="0.001" value={qty} onChange={(e) => setQty(e.target.value)} required />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
