import { FormEvent, useEffect, useState } from 'react';
import { get, post, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import { IconPlus } from '../components/Icon';

interface Product {
  id: string;
  name: string;
  name_en: string | null;
  category: string | null;
  sell_price: number | null;
  status: string;
  has_sizes: boolean;
}
interface RawMaterial {
  id: string;
  name: string;
  name_en: string | null;
  category: string | null;
}
interface IngredientRow {
  raw_material_id: string;
  usage_qty: string;
  usage_unit: string;
}
interface SizeRow {
  name: string;
  name_en: string;
  sell_price: string;
  ingredients: IngredientRow[];
}
interface SizeCost {
  id: string;
  name: string;
  raw_cost: number;
  full_cost: number;
  sell_price: number | null;
  profit: number | null;
  margin_pct: number | null;
}
interface CostBreakdown {
  has_sizes: boolean;
  total_fixed_monthly: number;
  estimated_orders: number;
  overhead_per_order: number;
  raw_cost?: number;
  full_cost?: number;
  sell_price?: number | null;
  profit?: number | null;
  margin_pct?: number | null;
  sizes?: SizeCost[];
}

const UNITS = ['g', 'kg', 'ml', 'l', 'pcs'];

function emptyIngredientRow(): IngredientRow {
  return { raw_material_id: '', usage_qty: '', usage_unit: 'g' };
}
function emptySizeRow(): SizeRow {
  return { name: '', name_en: '', sell_price: '', ingredients: [] };
}

export default function ProductsPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const [products, setProducts] = useState<Product[]>([]);
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [category, setCategory] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [hasSizes, setHasSizes] = useState(false);
  const [ingredientRows, setIngredientRows] = useState<IngredientRow[]>([]);
  const [sizeRows, setSizeRows] = useState<SizeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [costOpenId, setCostOpenId] = useState<string | null>(null);
  const [cost, setCost] = useState<CostBreakdown | null>(null);

  function load() {
    get<{ products: Product[] }>('/products')
      .then((r) => setProducts(r.products))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.products.loadFailed));
  }

  useEffect(() => {
    load();
    get<{ raw_materials: RawMaterial[] }>('/raw-materials').then((r) => setRawMaterials(r.raw_materials)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addIngredientRow() {
    setIngredientRows([...ingredientRows, emptyIngredientRow()]);
  }
  function updateIngredientRow(i: number, patch: Partial<IngredientRow>) {
    setIngredientRows(ingredientRows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeIngredientRow(i: number) {
    setIngredientRows(ingredientRows.filter((_, idx) => idx !== i));
  }

  function addSizeRow() {
    setSizeRows([...sizeRows, emptySizeRow()]);
  }
  function updateSizeRow(i: number, patch: Partial<SizeRow>) {
    setSizeRows(sizeRows.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function removeSizeRow(i: number) {
    setSizeRows(sizeRows.filter((_, idx) => idx !== i));
  }
  function addSizeIngredient(sizeIdx: number) {
    setSizeRows(sizeRows.map((s, idx) => (idx === sizeIdx ? { ...s, ingredients: [...s.ingredients, emptyIngredientRow()] } : s)));
  }
  function updateSizeIngredient(sizeIdx: number, ingIdx: number, patch: Partial<IngredientRow>) {
    setSizeRows(
      sizeRows.map((s, idx) =>
        idx === sizeIdx ? { ...s, ingredients: s.ingredients.map((ing, ii) => (ii === ingIdx ? { ...ing, ...patch } : ing)) } : s
      )
    );
  }
  function removeSizeIngredient(sizeIdx: number, ingIdx: number) {
    setSizeRows(sizeRows.map((s, idx) => (idx === sizeIdx ? { ...s, ingredients: s.ingredients.filter((_, ii) => ii !== ingIdx) } : s)));
  }

  function resetForm() {
    setName('');
    setNameEn('');
    setCategory('');
    setSellPrice('');
    setHasSizes(false);
    setIngredientRows([]);
    setSizeRows([]);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const toIngredientPayload = (rows: IngredientRow[]) =>
        rows
          .filter((r) => r.raw_material_id && r.usage_qty)
          .map((r) => ({ raw_material_id: r.raw_material_id, usage_qty: Number(r.usage_qty), usage_unit: r.usage_unit }));

      if (hasSizes) {
        await post('/products', {
          name,
          name_en: nameEn || undefined,
          category: category || undefined,
          has_sizes: true,
          sizes: sizeRows
            .filter((s) => s.name.trim())
            .map((s) => ({
              name: s.name.trim(),
              name_en: s.name_en.trim() || undefined,
              sell_price: s.sell_price ? Number(s.sell_price) : undefined,
              ingredients: toIngredientPayload(s.ingredients),
            })),
        });
      } else {
        await post('/products', {
          name,
          name_en: nameEn || undefined,
          category: category || undefined,
          sell_price: sellPrice ? Number(sellPrice) : undefined,
          ingredients: toIngredientPayload(ingredientRows),
        });
      }
      resetForm();
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.products.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  function openCost(id: string) {
    setCostOpenId(id);
    setCost(null);
    get<CostBreakdown>(`/products/${id}/cost`)
      .then(setCost)
      .catch((err) => setError(err instanceof ApiError ? err.message : t.products.loadFailed));
  }

  const materialName = (m: RawMaterial) => (lang === 'en' && m.name_en ? m.name_en : m.name);

  function renderIngredientEditor(
    rows: IngredientRow[],
    onAdd: () => void,
    onUpdate: (i: number, patch: Partial<IngredientRow>) => void,
    onRemove: (i: number) => void
  ) {
    return (
      <>
        {rows.map((row, i) => (
          <div key={i} className="form-row" style={{ marginBottom: 8 }}>
            <div className="field" style={{ flex: 2 }}>
              <select value={row.raw_material_id} onChange={(e) => onUpdate(i, { raw_material_id: e.target.value })}>
                <option value="">{t.products.selectRawMaterial}</option>
                {rawMaterials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {materialName(m)} {m.category ? `(${m.category})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <input type="number" step="0.001" placeholder="qty" value={row.usage_qty} onChange={(e) => onUpdate(i, { usage_qty: e.target.value })} />
            </div>
            <div className="field">
              <select value={row.usage_unit} onChange={(e) => onUpdate(i, { usage_unit: e.target.value })}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
            <button className="icon-btn" type="button" onClick={() => onRemove(i)} style={{ alignSelf: 'center' }}>
              ×
            </button>
          </div>
        ))}
        <button className="btn btn-secondary btn-sm" type="button" onClick={onAdd}>
          <IconPlus /> {t.products.addIngredient}
        </button>
      </>
    );
  }

  return (
    <div>
      <PageHeader title={t.products.title} subtitle={t.products.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.products.count(products.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          <IconPlus /> {t.products.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.products.name}</th>
                <th>{t.products.category}</th>
                <th className="num">{t.products.sellPrice}</th>
                <th>{t.products.status}</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} onClick={() => openCost(p.id)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 700 }}>
                    {p.name}
                    {p.name_en && <span className="muted" style={{ fontWeight: 400 }}> ({p.name_en})</span>}
                    {p.has_sizes && (
                      <>
                        {' '}
                        <Tag color="amber">{t.products.tagSizes}</Tag>
                      </>
                    )}
                  </td>
                  <td>{p.category || '—'}</td>
                  <td className="num">{p.has_sizes ? t.products.multiplePrices : p.sell_price !== null ? `${Number(p.sell_price).toFixed(3)} KD` : '—'}</td>
                  <td>{p.status === 'active' ? <Tag color="green">{t.common.active}</Tag> : <Tag color="gray">{p.status}</Tag>}</td>
                </tr>
              ))}
              {products.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <div className="empty-state">{t.products.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {costOpenId && (
        <div className="card">
          <div className="card-head">
            <h2>{products.find((p) => p.id === costOpenId)?.name}</h2>
          </div>
          <div className="card-body">
            {!cost && <p className="muted">{t.common.loading}</p>}

            {cost && !cost.has_sizes && (
              <div className="stat-grid">
                <div className="stat-card">
                  <div className="stat-label">{t.products.rawCost}</div>
                  <div className="stat-value">{cost.raw_cost!.toFixed(3)} KD</div>
                </div>
                <div className="stat-card amber">
                  <div className="stat-label">{t.products.overheadPerOrder}</div>
                  <div className="stat-value">{cost.overhead_per_order.toFixed(3)} KD</div>
                </div>
                <div className="stat-card blue">
                  <div className="stat-label">{t.products.fullCost}</div>
                  <div className="stat-value">{cost.full_cost!.toFixed(3)} KD</div>
                </div>
                <div className={`stat-card ${cost.profit !== null && cost.profit! >= 0 ? 'green' : 'red'}`}>
                  <div className="stat-label">{t.products.profitMargin}</div>
                  <div className="stat-value">
                    {cost.profit !== null && cost.profit !== undefined ? `${cost.profit.toFixed(3)} KD` : '—'}
                    {cost.margin_pct !== null && cost.margin_pct !== undefined && ` (${cost.margin_pct.toFixed(0)}%)`}
                  </div>
                </div>
              </div>
            )}

            {cost && cost.has_sizes && (
              <div>
                {cost.sizes!.map((s) => (
                  <div key={s.id} style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>{s.name}</div>
                    <div className="stat-grid">
                      <div className="stat-card">
                        <div className="stat-label">{t.products.rawCost}</div>
                        <div className="stat-value">{s.raw_cost.toFixed(3)} KD</div>
                      </div>
                      <div className="stat-card blue">
                        <div className="stat-label">{t.products.fullCost}</div>
                        <div className="stat-value">{s.full_cost.toFixed(3)} KD</div>
                      </div>
                      <div className={`stat-card ${s.profit !== null && s.profit >= 0 ? 'green' : 'red'}`}>
                        <div className="stat-label">{t.products.profitMargin}</div>
                        <div className="stat-value">
                          {s.profit !== null ? `${s.profit.toFixed(3)} KD` : '—'}
                          {s.margin_pct !== null && ` (${s.margin_pct.toFixed(0)}%)`}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {cost && (
              <p className="muted" style={{ marginTop: 12, marginBottom: 0, fontSize: 11 }}>
                {t.products.overheadNote(cost.total_fixed_monthly.toFixed(3), cost.estimated_orders)}
              </p>
            )}
          </div>
        </div>
      )}

      {open && (
        <Modal
          title={t.products.newItem}
          onClose={() => {
            setOpen(false);
            resetForm();
          }}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="product-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  setOpen(false);
                  resetForm();
                }}
              >
                {t.common.cancel}
              </button>
            </>
          }
        >
          <form id="product-form" onSubmit={handleSubmit}>
            <div className="field-grid">
              <div className="field">
                <label>{t.products.nameAr}</label>
                <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
              </div>
              <div className="field">
                <label>{t.products.nameEn}</label>
                <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
              </div>
              <div className="field">
                <label>{t.products.category}</label>
                <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="main, drink..." />
              </div>
              {!hasSizes && (
                <div className="field">
                  <label>{t.products.sellPrice} (KD)</label>
                  <input type="number" step="0.001" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} />
                </div>
              )}
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13 }}>
              <input type="checkbox" checked={hasSizes} onChange={(e) => setHasSizes(e.target.checked)} style={{ width: 'auto' }} />
              {t.products.hasSizes}
            </label>

            <div className="hr" />

            {!hasSizes && (
              <>
                <div className="section-title-row">
                  <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.products.ingredients}</span>
                </div>
                {renderIngredientEditor(ingredientRows, addIngredientRow, updateIngredientRow, removeIngredientRow)}
                {ingredientRows.length === 0 && rawMaterials.length === 0 && (
                  <p className="muted" style={{ fontSize: 12 }}>
                    {t.products.addRawMaterialFirst}
                  </p>
                )}
              </>
            )}

            {hasSizes && (
              <>
                <div className="section-title-row">
                  <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.products.sizesTitle}</span>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={addSizeRow}>
                    <IconPlus /> {t.products.addSize}
                  </button>
                </div>
                {sizeRows.map((size, sizeIdx) => (
                  <div key={sizeIdx} className="card" style={{ marginBottom: 10 }}>
                    <div className="card-body">
                      <div className="form-row">
                        <div className="field">
                          <label>{t.products.sizeName}</label>
                          <input value={size.name} onChange={(e) => updateSizeRow(sizeIdx, { name: e.target.value })} required />
                        </div>
                        <div className="field">
                          <label>{t.products.sizeNameEn}</label>
                          <input value={size.name_en} onChange={(e) => updateSizeRow(sizeIdx, { name_en: e.target.value })} />
                        </div>
                        <div className="field">
                          <label>{t.products.sizePrice}</label>
                          <input
                            type="number"
                            step="0.001"
                            value={size.sell_price}
                            onChange={(e) => updateSizeRow(sizeIdx, { sell_price: e.target.value })}
                          />
                        </div>
                        <button className="icon-btn" type="button" onClick={() => removeSizeRow(sizeIdx)} style={{ alignSelf: 'center' }}>
                          ×
                        </button>
                      </div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 6 }}>
                        {t.products.sizeIngredients}
                      </div>
                      {renderIngredientEditor(
                        size.ingredients,
                        () => addSizeIngredient(sizeIdx),
                        (i, patch) => updateSizeIngredient(sizeIdx, i, patch),
                        (i) => removeSizeIngredient(sizeIdx, i)
                      )}
                    </div>
                  </div>
                ))}
                {sizeRows.length === 0 && (
                  <p className="muted" style={{ fontSize: 12 }}>
                    {t.products.addSize}
                  </p>
                )}
              </>
            )}
          </form>
        </Modal>
      )}
    </div>
  );
}
