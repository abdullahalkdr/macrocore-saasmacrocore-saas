import { FormEvent, useEffect, useState } from 'react';
import { get, post, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { IconPlus } from '../components/Icon';

interface RawMaterial {
  id: string;
  name: string;
  name_en: string | null;
  category: string | null;
  package_qty: number | null;
  package_unit: string | null;
  purchase_price: number | null;
  supplier_name: string | null;
}

const UNITS = ['g', 'kg', 'ml', 'l', 'pcs'];

export default function RawMaterialsPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const [items, setItems] = useState<RawMaterial[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [category, setCategory] = useState('ingredient');
  const [packageQty, setPackageQty] = useState('');
  const [packageUnit, setPackageUnit] = useState('g');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    get<{ raw_materials: RawMaterial[] }>('/raw-materials')
      .then((r) => setItems(r.raw_materials))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.rawMaterials.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await post('/raw-materials', {
        name,
        name_en: nameEn || undefined,
        category: category || undefined,
        package_qty: packageQty ? Number(packageQty) : undefined,
        package_unit: packageUnit || undefined,
        purchase_price: purchasePrice ? Number(purchasePrice) : undefined,
        supplier_name: supplierName || undefined,
      });
      setName('');
      setNameEn('');
      setCategory('ingredient');
      setPackageQty('');
      setPackageUnit('g');
      setPurchasePrice('');
      setSupplierName('');
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.rawMaterials.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader title={t.rawMaterials.title} subtitle={t.rawMaterials.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.rawMaterials.count(items.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          <IconPlus /> {t.rawMaterials.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.rawMaterials.name}</th>
                <th>{t.rawMaterials.category}</th>
                <th>{t.rawMaterials.packageQty}</th>
                <th className="num">{t.rawMaterials.purchasePrice}</th>
                <th>{t.rawMaterials.supplier}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontWeight: 700 }}>
                    {m.name}
                    {m.name_en && <span className="muted" style={{ fontWeight: 400 }}> ({m.name_en})</span>}
                  </td>
                  <td>{m.category || '—'}</td>
                  <td>{m.package_qty ? `${m.package_qty} ${m.package_unit || ''}` : '—'}</td>
                  <td className="num">{m.purchase_price !== null ? `${Number(m.purchase_price).toFixed(3)} KD` : '—'}</td>
                  <td>{m.supplier_name || '—'}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">{t.rawMaterials.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={t.rawMaterials.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="raw-material-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                {t.common.cancel}
              </button>
            </>
          }
        >
          <form id="raw-material-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.rawMaterials.name} ({lang === 'ar' ? 'عربي' : 'Arabic'})</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label>{t.rawMaterials.name} (English)</label>
              <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.rawMaterials.category}</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="ingredient">ingredient</option>
                <option value="packaging">packaging</option>
              </select>
            </div>
            <div className="field">
              <label>{t.rawMaterials.packageQty}</label>
              <input type="number" step="0.001" value={packageQty} onChange={(e) => setPackageQty(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.rawMaterials.packageUnit}</label>
              <select value={packageUnit} onChange={(e) => setPackageUnit(e.target.value)}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.rawMaterials.purchasePrice} (KD)</label>
              <input type="number" step="0.001" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.rawMaterials.supplier}</label>
              <input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
