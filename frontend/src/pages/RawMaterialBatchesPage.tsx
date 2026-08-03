import { FormEvent, useEffect, useState } from 'react';
import { get, patch, post, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { IconPlus, IconTrash } from '../components/Icon';

interface RawMaterial {
  id: string;
  name: string;
  name_en: string | null;
  package_unit: string | null;
}

interface Location {
  id: string;
  name: string;
  type: 'kiosk' | 'warehouse';
}

interface Batch {
  id: string;
  raw_material_id: string;
  location_id: string;
  purchase_date: string; // YYYY-MM-DD
  expiry_date: string | null;
  qty_purchased: number;
  qty_remaining: number;
  purchase_price: number;
  unit: string;
  days_until_expiry: number | null;
  created_at: string;
}

interface BatchWithMaterial extends Batch {
  material_name?: string;
  location_name?: string;
}

export default function RawMaterialBatchesPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const [batches, setBatches] = useState<BatchWithMaterial[]>([]);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form fields
  const [rawMaterialId, setRawMaterialId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [qtyPurchased, setQtyPurchased] = useState('');
  const [qtyRemaining, setQtyRemaining] = useState('');
  const [purchasePrice, setPurchasePrice] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    Promise.all([
      get<{ batches: Batch[] }>('/raw-material-batches'),
      get<{ raw_materials: RawMaterial[] }>('/raw-materials'),
      get<{ locations: Location[] }>('/locations'),
    ])
      .then(([batchesRes, materialsRes, locationsRes]) => {
        setMaterials(materialsRes.raw_materials);
        setLocations(locationsRes.locations);
        const enriched = batchesRes.batches.map((b) => {
          const material = materialsRes.raw_materials.find((m) => m.id === b.raw_material_id);
          const materialName = (lang === 'en' && material?.name_en) || material?.name || '—';
          return {
            ...b,
            material_name: materialName,
            location_name: locationsRes.locations.find((l) => l.id === b.location_id)?.name || '—',
          };
        });
        setBatches(enriched);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t.rawMaterialBatches.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (editingId) {
        // Note: qty_remaining=0 (and price=0) are valid, deliberate values (e.g.
        // zeroing a batch out before deleting it) — check for '' specifically, not
        // falsiness, or a typed 0 would silently be dropped from the request.
        await patch(`/raw-material-batches/${editingId}`, {
          purchase_date: purchaseDate || undefined,
          expiry_date: expiryDate || undefined,
          qty_purchased: qtyPurchased !== '' ? Number(qtyPurchased) : undefined,
          qty_remaining: qtyRemaining !== '' ? Number(qtyRemaining) : undefined,
          purchase_price: purchasePrice !== '' ? Number(purchasePrice) : undefined,
        });
      } else {
        // Create new batch
        await post('/raw-material-batches', {
          raw_material_id: rawMaterialId,
          location_id: locationId,
          purchase_date: purchaseDate,
          expiry_date: expiryDate || undefined,
          qty_purchased: qtyPurchased ? Number(qtyPurchased) : undefined,
          purchase_price: purchasePrice ? Number(purchasePrice) : undefined,
        });
      }
      resetForm();
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.rawMaterialBatches.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setRawMaterialId('');
    setLocationId('');
    setPurchaseDate('');
    setExpiryDate('');
    setQtyPurchased('');
    setQtyRemaining('');
    setPurchasePrice('');
    setEditingId(null);
  }

  function openEditModal(batch: BatchWithMaterial) {
    setEditingId(batch.id);
    setRawMaterialId(batch.raw_material_id);
    setLocationId(batch.location_id);
    setPurchaseDate(batch.purchase_date);
    setExpiryDate(batch.expiry_date || '');
    setQtyPurchased(String(batch.qty_purchased));
    setQtyRemaining(String(batch.qty_remaining));
    setPurchasePrice(String(batch.purchase_price));
    setOpen(true);
  }

  async function handleDelete(batch: BatchWithMaterial) {
    if (!confirm(t.rawMaterialBatches.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/raw-material-batches/${batch.id}`);
      load();
    } catch (err) {
      // The backend's only 400 on this endpoint is "still has remaining quantity" —
      // show the localized, actionable version instead of the raw English message.
      if (err instanceof ApiError && err.status === 400) {
        setError(t.rawMaterialBatches.deleteBlockedRemaining);
      } else {
        setError(err instanceof ApiError ? err.message : t.rawMaterialBatches.deleteFailed);
      }
    }
  }

  function getExpiryStatus(batch: BatchWithMaterial): 'expired' | 'expiring' | 'safe' {
    if (!batch.days_until_expiry) return 'safe';
    if (batch.days_until_expiry < 0) return 'expired';
    if (batch.days_until_expiry <= 30) return 'expiring';
    return 'safe';
  }

  function getStatusColor(status: 'expired' | 'expiring' | 'safe'): string {
    if (status === 'expired') return '#e74c3c'; // red
    if (status === 'expiring') return '#f39c12'; // orange
    return '#27ae60'; // green
  }

  const selectedMaterialUnit = materials.find((m) => m.id === rawMaterialId)?.package_unit || '';

  const expiringBatches = batches.filter((b) => getExpiryStatus(b) !== 'safe');
  const safeBatches = batches.filter((b) => getExpiryStatus(b) === 'safe');

  return (
    <div>
      <PageHeader
        title={t.rawMaterialBatches.title}
        subtitle={t.rawMaterialBatches.subtitle}
      />
      {error && <div className="error-banner">{error}</div>}

      {expiringBatches.length > 0 && (
        <div style={{ padding: '12px', backgroundColor: '#ffe6e6', borderLeft: '4px solid #e74c3c', marginBottom: '16px', borderRadius: '4px' }}>
          <strong>{t.rawMaterialBatches.expiryAlert(expiringBatches.length)}</strong>
        </div>
      )}

      <div className="section-title-row">
        <span className="muted">{t.rawMaterialBatches.total(batches.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={() => { resetForm(); setOpen(true); }}>
          <IconPlus /> {t.rawMaterialBatches.newItem}
        </button>
      </div>

      {/* Expiring/Expired batches first */}
      {expiringBatches.length > 0 && (
        <>
          <h3 style={{ marginTop: '20px', marginBottom: '12px' }}>{t.rawMaterialBatches.expiringSectionTitle}</h3>
          <div className="card">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t.rawMaterialBatches.material}</th>
                    <th>{t.rawMaterialBatches.location}</th>
                    <th>{t.rawMaterialBatches.purchaseDate}</th>
                    <th>{t.rawMaterialBatches.expiryDate}</th>
                    <th>{t.rawMaterialBatches.daysLeft}</th>
                    <th className="num">{t.rawMaterialBatches.qtyRemaining}</th>
                    <th>{t.rawMaterialBatches.unit}</th>
                    <th className="num">{t.rawMaterialBatches.purchasePrice}</th>
                    <th>{t.rawMaterialBatches.status}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {expiringBatches.map((b) => (
                    <tr key={b.id}>
                      <td>{b.material_name}</td>
                      <td>{b.location_name}</td>
                      <td>{new Date(b.purchase_date).toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB')}</td>
                      <td>{b.expiry_date ? new Date(b.expiry_date).toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB') : '—'}</td>
                      <td className="num" style={{ color: getStatusColor(getExpiryStatus(b)) }}>
                        <strong>{b.days_until_expiry !== null ? b.days_until_expiry : '—'}</strong>
                      </td>
                      <td className="num">{Number(b.qty_remaining).toFixed(3)}</td>
                      <td>{b.unit}</td>
                      <td className="num">{Number(b.purchase_price).toFixed(3)}</td>
                      <td>
                        <span style={{ color: getStatusColor(getExpiryStatus(b)), fontWeight: 'bold' }}>
                          {getExpiryStatus(b) === 'expired' && t.rawMaterialBatches.statusExpired}
                          {getExpiryStatus(b) === 'expiring' && t.rawMaterialBatches.statusExpiring}
                        </span>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-sm" onClick={() => openEditModal(b)}>{t.rawMaterialBatches.edit}</button>
                        <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(b)}>
                          <IconTrash />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Safe batches */}
      <h3 style={{ marginTop: '20px', marginBottom: '12px' }}>{t.rawMaterialBatches.safeSectionTitle}</h3>
      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.rawMaterialBatches.material}</th>
                <th>{t.rawMaterialBatches.location}</th>
                <th>{t.rawMaterialBatches.purchaseDate}</th>
                <th>{t.rawMaterialBatches.expiryDate}</th>
                <th>{t.rawMaterialBatches.daysLeft}</th>
                <th className="num">{t.rawMaterialBatches.qtyPurchased}</th>
                <th className="num">{t.rawMaterialBatches.qtyRemaining}</th>
                <th>{t.rawMaterialBatches.unit}</th>
                <th className="num">{t.rawMaterialBatches.purchasePrice}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {safeBatches.map((b) => (
                <tr key={b.id}>
                  <td style={{ fontWeight: 700 }}>{b.material_name}</td>
                  <td>{b.location_name}</td>
                  <td>{new Date(b.purchase_date).toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB')}</td>
                  <td>{b.expiry_date ? new Date(b.expiry_date).toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB') : t.rawMaterialBatches.noDate}</td>
                  <td className="num">{b.days_until_expiry !== null ? b.days_until_expiry : '∞'}</td>
                  <td className="num">{Number(b.qty_purchased).toFixed(3)}</td>
                  <td className="num">{Number(b.qty_remaining).toFixed(3)}</td>
                  <td>{b.unit}</td>
                  <td className="num">{Number(b.purchase_price).toFixed(3)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm" onClick={() => openEditModal(b)}>{t.rawMaterialBatches.edit}</button>
                    <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(b)}>
                      <IconTrash />
                    </button>
                  </td>
                </tr>
              ))}
              {safeBatches.length === 0 && (
                <tr>
                  <td colSpan={10}>
                    <div className="empty-state">{t.rawMaterialBatches.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={editingId ? t.rawMaterialBatches.editItem : t.rawMaterialBatches.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="batch-form" disabled={loading}>
                {loading ? t.common.loading : t.rawMaterialBatches.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                {t.rawMaterialBatches.cancel}
              </button>
            </>
          }
        >
          <form id="batch-form" onSubmit={handleSubmit} className="field-grid">
            {!editingId && (
              <>
                <div className="field">
                  <label>{t.rawMaterialBatches.material} *</label>
                  <select value={rawMaterialId} onChange={(e) => setRawMaterialId(e.target.value)} required>
                    <option value="">{t.rawMaterialBatches.selectMaterial}</option>
                    {materials.map((m) => (
                      <option key={m.id} value={m.id}>
                        {(lang === 'en' && m.name_en) || m.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label>{t.rawMaterialBatches.location} *</label>
                  <select value={locationId} onChange={(e) => setLocationId(e.target.value)} required>
                    <option value="">{t.rawMaterialBatches.selectLocation}</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.type === 'warehouse' ? t.locations.typeWarehouse : t.locations.typeKiosk})
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {editingId && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <p className="muted" style={{ fontSize: 12 }}>{t.rawMaterialBatches.editHint}</p>
              </div>
            )}

            <div className="field">
              <label>{t.rawMaterialBatches.purchaseDate} *</label>
              <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} required />
            </div>

            <div className="field">
              <label>
                {t.rawMaterialBatches.qtyPurchased} * {selectedMaterialUnit && `(${selectedMaterialUnit})`}
              </label>
              <input type="number" step="0.001" value={qtyPurchased} onChange={(e) => setQtyPurchased(e.target.value)} required />
              {selectedMaterialUnit && <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>{t.rawMaterialBatches.unitHint(selectedMaterialUnit)}</p>}
            </div>

            {editingId && (
              <div className="field">
                <label>
                  {t.rawMaterialBatches.qtyRemaining} * {selectedMaterialUnit && `(${selectedMaterialUnit})`}
                </label>
                <input type="number" step="0.001" value={qtyRemaining} onChange={(e) => setQtyRemaining(e.target.value)} required />
              </div>
            )}

            <div className="field">
              <label>
                {t.rawMaterialBatches.purchasePrice} * {selectedMaterialUnit && `(${t.rawMaterialBatches.perUnit(selectedMaterialUnit)})`}
              </label>
              <input type="number" step="0.001" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} required />
            </div>

            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.rawMaterialBatches.expiryDateOptional}</label>
              <input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
              />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
