import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, ApiError } from '../api/client';
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
  min_stock_qty: number | null;
}

const UNITS = ['g', 'kg', 'ml', 'l', 'pcs'];

const CATEGORY_VALUES = ['ingredient', 'packaging'] as const;

function fmtQty(n: number): string {
  // Trim trailing zeros (5.000 -> 5, 2.500 -> 2.5) instead of always forcing 3 decimals.
  return String(parseFloat(n.toFixed(3)));
}

export default function RawMaterialsPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const CATEGORY_LABELS: Record<string, string> = {
    ingredient: t.rawMaterials.categoryIngredient,
    packaging: t.rawMaterials.categoryPackaging,
  };
  const [items, setItems] = useState<RawMaterial[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [category, setCategory] = useState('ingredient');
  const [packageQty, setPackageQty] = useState('');
  const [packageUnit, setPackageUnit] = useState('g');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [minStockQty, setMinStockQty] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    get<{ raw_materials: RawMaterial[] }>('/raw-materials')
      .then((r) => setItems(r.raw_materials))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.rawMaterials.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  function resetForm() {
    setName('');
    setNameEn('');
    setCategory('ingredient');
    setPackageQty('');
    setPackageUnit('g');
    setPurchasePrice('');
    setSupplierName('');
    setMinStockQty('');
    setEditingId(null);
  }

  function openCreate() {
    resetForm();
    setOpen(true);
  }

  function openEdit(m: RawMaterial) {
    setEditingId(m.id);
    setName(m.name);
    setNameEn(m.name_en || '');
    setCategory(m.category || 'ingredient');
    setPackageQty(m.package_qty !== null ? String(m.package_qty) : '');
    setPackageUnit(m.package_unit || 'g');
    setPurchasePrice(m.purchase_price !== null ? String(m.purchase_price) : '');
    setSupplierName(m.supplier_name || '');
    setMinStockQty(m.min_stock_qty !== null ? String(m.min_stock_qty) : '');
    setOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload = {
        name,
        name_en: nameEn || undefined,
        category: category || undefined,
        package_qty: packageQty ? Number(packageQty) : undefined,
        package_unit: packageUnit || undefined,
        purchase_price: purchasePrice ? Number(purchasePrice) : undefined,
        supplier_name: supplierName || undefined,
        min_stock_qty: minStockQty ? Number(minStockQty) : null,
      };
      if (editingId) {
        await patch(`/raw-materials/${editingId}`, payload);
      } else {
        await post('/raw-materials', payload);
      }
      resetForm();
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
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
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
                <th className="num">{t.rawMaterials.packageQty}</th>
                <th className="num">{t.rawMaterials.purchasePrice}</th>
                <th>{t.rawMaterials.supplier}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} onClick={() => openEdit(m)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 700 }}>
                    {m.name}
                    {m.name_en && <span className="muted" style={{ fontWeight: 400 }}> ({m.name_en})</span>}
                  </td>
                  <td>{m.category ? CATEGORY_LABELS[m.category] || m.category : '—'}</td>
                  <td className="num">{m.package_qty ? `${fmtQty(Number(m.package_qty))} ${m.package_unit || ''}` : '—'}</td>
                  <td className="num">{m.purchase_price !== null ? `${Number(m.purchase_price).toFixed(3)} KD` : '—'}</td>
                  <td>{m.supplier_name || '—'}</td>
                  <td>
                    <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); openEdit(m); }}>
                      {t.rawMaterials.edit}
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6}>
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
          title={editingId ? t.rawMaterials.editItem : t.rawMaterials.newItem}
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
                {CATEGORY_VALUES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
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
              <input
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                placeholder={t.rawMaterials.supplierPlaceholder}
                list="supplier-options"
              />
              <datalist id="supplier-options">
                {Array.from(new Set(items.map((m) => m.supplier_name).filter((s): s is string => !!s))).map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.rawMaterials.minStockQty}</label>
              <input type="number" step="0.001" min={0} value={minStockQty} onChange={(e) => setMinStockQty(e.target.value)} />
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{t.rawMaterials.minStockQtyHint}</div>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
