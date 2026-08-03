import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useAuthStore } from '../store/authStore';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import { IconPlus, IconEdit, IconTrash } from '../components/Icon';

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
  packaging: IngredientRow[];
}
interface CostPreview {
  raw_cost: number;
  item_costs: number[];
  overhead_per_order: number;
  full_cost: number;
  sell_price: number | null;
  profit: number | null;
  margin_pct: number | null;
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
  return { name: '', name_en: '', sell_price: '', ingredients: [], packaging: [] };
}
interface IngredientPayloadItem {
  raw_material_id: string;
  usage_qty: number;
  usage_unit: string;
  is_packaging: boolean;
}
function combineIngredients(food: IngredientRow[], packaging: IngredientRow[]): IngredientPayloadItem[] {
  const toPayload = (rows: IngredientRow[], isPackaging: boolean) =>
    rows
      .filter((r) => r.raw_material_id && r.usage_qty)
      .map((r) => ({ raw_material_id: r.raw_material_id, usage_qty: Number(r.usage_qty), usage_unit: r.usage_unit, is_packaging: isPackaging }));
  return [...toPayload(food, false), ...toPayload(packaging, true)];
}

// Same shape as combineIngredients, but keeps each row's original array index so a
// per-row cost returned by /products/cost-preview (item_costs, same order as the
// payload) can be mapped straight back onto the right row in the UI — including rows
// the user hasn't finished filling in yet, which combineIngredients silently drops.
function buildPreviewIngredients(food: IngredientRow[], packaging: IngredientRow[]) {
  const foodIdx: number[] = [];
  const packagingIdx: number[] = [];
  const payload: IngredientPayloadItem[] = [];
  food.forEach((r, i) => {
    if (r.raw_material_id && r.usage_qty) {
      foodIdx.push(i);
      payload.push({ raw_material_id: r.raw_material_id, usage_qty: Number(r.usage_qty), usage_unit: r.usage_unit, is_packaging: false });
    }
  });
  packaging.forEach((r, i) => {
    if (r.raw_material_id && r.usage_qty) {
      packagingIdx.push(i);
      payload.push({ raw_material_id: r.raw_material_id, usage_qty: Number(r.usage_qty), usage_unit: r.usage_unit, is_packaging: true });
    }
  });
  return { payload, foodIdx, packagingIdx };
}

const PRODUCT_CATEGORY_VALUES = ['cups_drinks', 'plates', 'snacks', 'desserts', 'addons'] as const;
const CATEGORY_OTHER = 'other';

export default function ProductsPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const PRODUCT_CATEGORY_LABELS: Record<string, string> = {
    cups_drinks: t.products.categoryCupsDrinks,
    plates: t.products.categoryPlates,
    snacks: t.products.categorySnacks,
    desserts: t.products.categoryDesserts,
    addons: t.products.categoryAddons,
    // legacy values from before the category list was aligned to the CornLab
    // reference — kept only so old products still display a translated label
    // instead of a raw slug.
    main: t.products.categoryMain,
    side: t.products.categorySide,
    drink: t.products.categoryDrink,
    dessert: t.products.categoryDessert,
    other: t.products.categoryOther,
  };
  const user = useAuthStore((s) => s.user);
  const isManager = user?.role === 'admin' || user?.role === 'manager';
  const [products, setProducts] = useState<Product[]>([]);
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [categorySelect, setCategorySelect] = useState('');
  const [categoryCustom, setCategoryCustom] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [hasSizes, setHasSizes] = useState(false);
  const [ingredientRows, setIngredientRows] = useState<IngredientRow[]>([]);
  const [packagingRows, setPackagingRows] = useState<IngredientRow[]>([]);
  const [sizeRows, setSizeRows] = useState<SizeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [livePreview, setLivePreview] = useState<CostPreview | null>(null);
  const [sizePreviews, setSizePreviews] = useState<Record<number, CostPreview>>({});
  const [ingredientCosts, setIngredientCosts] = useState<(number | null)[]>([]);
  const [packagingCosts, setPackagingCosts] = useState<(number | null)[]>([]);
  const [sizeIngredientCosts, setSizeIngredientCosts] = useState<Record<number, (number | null)[]>>({});
  const [sizePackagingCosts, setSizePackagingCosts] = useState<Record<number, (number | null)[]>>({});
  const ingredientMaterials = rawMaterials.filter((m) => m.category !== 'packaging');
  const packagingMaterials = rawMaterials.filter((m) => m.category === 'packaging');

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

  function addPackagingRow() {
    setPackagingRows([...packagingRows, emptyIngredientRow()]);
  }
  function updatePackagingRow(i: number, patch: Partial<IngredientRow>) {
    setPackagingRows(packagingRows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removePackagingRow(i: number) {
    setPackagingRows(packagingRows.filter((_, idx) => idx !== i));
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

  function addSizePackaging(sizeIdx: number) {
    setSizeRows(sizeRows.map((s, idx) => (idx === sizeIdx ? { ...s, packaging: [...s.packaging, emptyIngredientRow()] } : s)));
  }
  function updateSizePackaging(sizeIdx: number, pkgIdx: number, patch: Partial<IngredientRow>) {
    setSizeRows(
      sizeRows.map((s, idx) =>
        idx === sizeIdx ? { ...s, packaging: s.packaging.map((pkg, pi) => (pi === pkgIdx ? { ...pkg, ...patch } : pkg)) } : s
      )
    );
  }
  function removeSizePackaging(sizeIdx: number, pkgIdx: number) {
    setSizeRows(sizeRows.map((s, idx) => (idx === sizeIdx ? { ...s, packaging: s.packaging.filter((_, pi) => pi !== pkgIdx) } : s)));
  }

  function resetForm() {
    setName('');
    setNameEn('');
    setCategorySelect('');
    setCategoryCustom('');
    setSellPrice('');
    setHasSizes(false);
    setIngredientRows([]);
    setPackagingRows([]);
    setSizeRows([]);
    setLivePreview(null);
    setSizePreviews({});
    setIngredientCosts([]);
    setPackagingCosts([]);
    setSizeIngredientCosts({});
    setSizePackagingCosts({});
  }

  function openCreate() {
    resetForm();
    setEditingId(null);
    setOpen(true);
  }

  async function openEdit(p: Product) {
    setError(null);
    setEditingId(p.id);
    setName(p.name);
    setNameEn(p.name_en || '');
    const cat = p.category || '';
    if (cat && !(PRODUCT_CATEGORY_VALUES as readonly string[]).includes(cat)) {
      setCategorySelect(CATEGORY_OTHER);
      setCategoryCustom(cat);
    } else {
      setCategorySelect(cat);
      setCategoryCustom('');
    }
    setSellPrice(p.sell_price !== null ? String(p.sell_price) : '');
    setHasSizes(p.has_sizes);
    setIngredientRows([]);
    setPackagingRows([]);
    setSizeRows([]);
    setOpen(true);
    try {
      const detail = await get<{
        product: Product;
        ingredients?: { raw_material_id: string; usage_qty: number; usage_unit: string | null; is_packaging?: boolean }[];
        sizes?: {
          name: string;
          name_en: string | null;
          sell_price: number | null;
          ingredients: { raw_material_id: string; usage_qty: number; usage_unit: string | null; is_packaging?: boolean }[];
        }[];
      }>(`/products/${p.id}`);
      const toRow = (ing: { raw_material_id: string; usage_qty: number; usage_unit: string | null }): IngredientRow => ({
        raw_material_id: ing.raw_material_id,
        usage_qty: String(ing.usage_qty),
        usage_unit: ing.usage_unit || 'g',
      });
      if (detail.sizes) {
        setSizeRows(
          detail.sizes.map((s) => ({
            name: s.name,
            name_en: s.name_en || '',
            sell_price: s.sell_price !== null ? String(s.sell_price) : '',
            ingredients: s.ingredients.filter((ing) => !ing.is_packaging).map(toRow),
            packaging: s.ingredients.filter((ing) => ing.is_packaging).map(toRow),
          }))
        );
      } else if (detail.ingredients) {
        setIngredientRows(detail.ingredients.filter((ing) => !ing.is_packaging).map(toRow));
        setPackagingRows(detail.ingredients.filter((ing) => ing.is_packaging).map(toRow));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.products.loadFailed);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload = hasSizes
        ? {
            name,
            name_en: nameEn || undefined,
            category: categorySelect === CATEGORY_OTHER ? categoryCustom.trim() || undefined : categorySelect || undefined,
            has_sizes: true,
            sizes: sizeRows
              .filter((s) => s.name.trim())
              .map((s) => ({
                name: s.name.trim(),
                name_en: s.name_en.trim() || undefined,
                sell_price: s.sell_price ? Number(s.sell_price) : undefined,
                ingredients: combineIngredients(s.ingredients, s.packaging),
              })),
          }
        : {
            name,
            name_en: nameEn || undefined,
            category: categorySelect === CATEGORY_OTHER ? categoryCustom.trim() || undefined : categorySelect || undefined,
            has_sizes: false,
            sell_price: sellPrice ? Number(sellPrice) : undefined,
            ingredients: combineIngredients(ingredientRows, packagingRows),
          };

      if (editingId) {
        await patch(`/products/${editingId}`, payload);
      } else {
        await post('/products', payload);
      }
      resetForm();
      setEditingId(null);
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editingId ? t.products.updateFailed : t.products.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.products.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/products/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.products.deleteFailed);
    }
  }

  function openCost(id: string) {
    setCostOpenId(id);
    setCost(null);
    get<CostBreakdown>(`/products/${id}/cost`)
      .then(setCost)
      .catch((err) => setError(err instanceof ApiError ? err.message : t.products.loadFailed));
  }

  // Live cost/margin preview inside the add/edit modal — recalculates as the user
  // types, using the same server-side cost formula as the saved-product cost view
  // (GET /:id/cost), just fed an unsaved ingredient list instead.
  useEffect(() => {
    if (!open || hasSizes) return;
    const { payload, foodIdx, packagingIdx } = buildPreviewIngredients(ingredientRows, packagingRows);
    const handle = setTimeout(() => {
      post<CostPreview>('/products/cost-preview', { ingredients: payload, sell_price: sellPrice ? Number(sellPrice) : undefined })
        .then((res) => {
          setLivePreview(res);
          const fCosts: (number | null)[] = new Array(ingredientRows.length).fill(null);
          const pCosts: (number | null)[] = new Array(packagingRows.length).fill(null);
          foodIdx.forEach((origIdx, i) => { fCosts[origIdx] = res.item_costs[i]; });
          packagingIdx.forEach((origIdx, i) => { pCosts[origIdx] = res.item_costs[foodIdx.length + i]; });
          setIngredientCosts(fCosts);
          setPackagingCosts(pCosts);
        })
        .catch(() => {});
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasSizes, ingredientRows, packagingRows, sellPrice]);

  useEffect(() => {
    if (!open || !hasSizes) return;
    const timers = sizeRows.map((size, idx) =>
      setTimeout(() => {
        const { payload, foodIdx, packagingIdx } = buildPreviewIngredients(size.ingredients, size.packaging);
        post<CostPreview>('/products/cost-preview', { ingredients: payload, sell_price: size.sell_price ? Number(size.sell_price) : undefined })
          .then((res) => {
            setSizePreviews((prev) => ({ ...prev, [idx]: res }));
            const fCosts: (number | null)[] = new Array(size.ingredients.length).fill(null);
            const pCosts: (number | null)[] = new Array(size.packaging.length).fill(null);
            foodIdx.forEach((origIdx, i) => { fCosts[origIdx] = res.item_costs[i]; });
            packagingIdx.forEach((origIdx, i) => { pCosts[origIdx] = res.item_costs[foodIdx.length + i]; });
            setSizeIngredientCosts((prev) => ({ ...prev, [idx]: fCosts }));
            setSizePackagingCosts((prev) => ({ ...prev, [idx]: pCosts }));
          })
          .catch(() => {});
      }, 400)
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasSizes, sizeRows]);

  const materialName = (m: RawMaterial) => (lang === 'en' && m.name_en ? m.name_en : m.name);

  // materials: pre-filtered by category (ingredient-only or packaging-only — never
  // both, so a cup can't accidentally get picked as a recipe ingredient and a corn
  // batch can't get picked as packaging). showUnit hides the unit selector for
  // packaging rows, since packaging is always counted by piece. costs is a per-row
  // live cost readout aligned to `rows` by index (null until the debounced preview
  // resolves), sourced from /products/cost-preview's item_costs.
  function renderIngredientEditor(
    rows: IngredientRow[],
    onAdd: () => void,
    onUpdate: (i: number, patch: Partial<IngredientRow>) => void,
    onRemove: (i: number) => void,
    materials: RawMaterial[],
    showUnit: boolean,
    costs: (number | null)[],
    emptyHint: string
  ) {
    return (
      <>
        {rows.length > 0 && (
          <div className="form-row" style={{ marginBottom: 4, fontSize: 11, fontWeight: 700, color: 'var(--stone-500)' }}>
            <div style={{ flex: 2 }}>{t.products.colMaterial}</div>
            <div style={{ flex: 1 }}>{t.products.colQty}</div>
            {showUnit && <div style={{ flex: 1 }}>{t.products.colUnit}</div>}
            <div style={{ flex: 1 }}>{t.products.colCost}</div>
            <div style={{ width: 30 }} />
          </div>
        )}
        {rows.map((row, i) => (
          <div key={i} className="form-row" style={{ marginBottom: 8 }}>
            <div className="field" style={{ flex: 2 }}>
              <select value={row.raw_material_id} onChange={(e) => onUpdate(i, { raw_material_id: e.target.value })}>
                <option value="">{t.products.selectRawMaterial}</option>
                {materials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {materialName(m)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <input type="number" step="0.001" placeholder="qty" value={row.usage_qty} onChange={(e) => onUpdate(i, { usage_qty: e.target.value })} />
            </div>
            {showUnit && (
              <div className="field">
                <select value={row.usage_unit} onChange={(e) => onUpdate(i, { usage_unit: e.target.value })}>
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="field" style={{ justifyContent: 'center' }}>
              <span className="muted" style={{ fontSize: 12, fontWeight: 700 }}>
                {costs[i] != null ? `${costs[i]!.toFixed(3)} KD` : '—'}
              </span>
            </div>
            <button className="icon-btn" type="button" onClick={() => onRemove(i)} style={{ alignSelf: 'center' }} title={t.common.delete}>
              <IconTrash />
            </button>
          </div>
        ))}
        {rows.length === 0 && materials.length === 0 && (
          <p className="muted" style={{ fontSize: 12 }}>
            {emptyHint}
          </p>
        )}
        <button className="btn btn-secondary btn-sm" type="button" onClick={onAdd}>
          <IconPlus /> {t.products.addIngredient}
        </button>
      </>
    );
  }

  function renderLiveStats(preview: CostPreview | null) {
    return (
      <div className="stat-grid" style={{ marginTop: 10 }}>
        <div className={`stat-card ${preview && preview.margin_pct !== null && preview.margin_pct >= 0 ? 'green' : 'red'}`}>
          <div className="stat-label">{t.products.liveMarginLabel}</div>
          <div className="stat-value">{preview && preview.margin_pct !== null ? `${preview.margin_pct.toFixed(1)}%` : '—'}</div>
        </div>
        <div className={`stat-card ${preview && preview.profit !== null && preview.profit >= 0 ? 'green' : 'red'}`}>
          <div className="stat-label">{t.products.liveProfitLabel}</div>
          <div className="stat-value">{preview && preview.profit !== null ? `${preview.profit.toFixed(3)} KD` : '—'}</div>
        </div>
        <div className="stat-card amber">
          <div className="stat-label">{t.products.liveOverheadLabel}</div>
          <div className="stat-value">{preview ? preview.overhead_per_order.toFixed(3) : '0.000'} KD</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t.products.liveRawCostLabel}</div>
          <div className="stat-value">{preview ? preview.raw_cost.toFixed(3) : '0.000'} KD</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={t.products.title} subtitle={t.products.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.products.count(products.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
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
                {isManager && <th></th>}
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
                  <td>{p.category ? PRODUCT_CATEGORY_LABELS[p.category] || p.category : '—'}</td>
                  <td className="num">{p.has_sizes ? t.products.multiplePrices : p.sell_price !== null ? `${Number(p.sell_price).toFixed(3)} KD` : '—'}</td>
                  <td>{p.status === 'active' ? <Tag color="green">{t.common.active}</Tag> : <Tag color="gray">{p.status}</Tag>}</td>
                  {isManager && (
                    <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                      <button className="icon-btn" title={t.products.editItem} onClick={() => openEdit(p)}>
                        <IconEdit />
                      </button>
                      <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(p.id)}>
                        <IconTrash />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {products.length === 0 && (
                <tr>
                  <td colSpan={isManager ? 5 : 4}>
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
            <h2>{(() => {
              const p = products.find((pp) => pp.id === costOpenId);
              return p ? (lang === 'en' && p.name_en) || p.name : '';
            })()}</h2>
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
          title={editingId ? t.products.editItem : t.products.newItem}
          onClose={() => {
            setOpen(false);
            setEditingId(null);
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
                  setEditingId(null);
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
                <select value={categorySelect} onChange={(e) => setCategorySelect(e.target.value)}>
                  <option value="">{t.products.selectCategory}</option>
                  {PRODUCT_CATEGORY_VALUES.map((c) => (
                    <option key={c} value={c}>
                      {PRODUCT_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                  <option value={CATEGORY_OTHER}>{t.products.categoryOther}</option>
                </select>
              </div>
              {categorySelect === CATEGORY_OTHER && (
                <div className="field">
                  <label>{t.products.categoryCustomPlaceholder}</label>
                  <input value={categoryCustom} onChange={(e) => setCategoryCustom(e.target.value)} placeholder={t.products.categoryCustomPlaceholder} />
                </div>
              )}
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
                  <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.products.ingredientsOnly}</span>
                </div>
                {renderIngredientEditor(
                  ingredientRows,
                  addIngredientRow,
                  updateIngredientRow,
                  removeIngredientRow,
                  ingredientMaterials,
                  true,
                  ingredientCosts,
                  t.products.noIngredientMaterials
                )}

                <div className="section-title-row" style={{ marginTop: 16 }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.products.packagingTitle}</span>
                </div>
                {renderIngredientEditor(
                  packagingRows,
                  addPackagingRow,
                  updatePackagingRow,
                  removePackagingRow,
                  packagingMaterials,
                  false,
                  packagingCosts,
                  t.products.noPackagingMaterials
                )}

                {renderLiveStats(livePreview)}
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
                        <button className="icon-btn" type="button" onClick={() => removeSizeRow(sizeIdx)} style={{ alignSelf: 'center' }} title={t.common.delete}>
                          <IconTrash />
                        </button>
                      </div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 6 }}>
                        {t.products.sizeIngredients}
                      </div>
                      {renderIngredientEditor(
                        size.ingredients,
                        () => addSizeIngredient(sizeIdx),
                        (i, patch) => updateSizeIngredient(sizeIdx, i, patch),
                        (i) => removeSizeIngredient(sizeIdx, i),
                        ingredientMaterials,
                        true,
                        sizeIngredientCosts[sizeIdx] ?? [],
                        t.products.noIngredientMaterials
                      )}

                      <div className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 6 }}>
                        {t.products.packagingTitle}
                      </div>
                      {renderIngredientEditor(
                        size.packaging,
                        () => addSizePackaging(sizeIdx),
                        (i, patch) => updateSizePackaging(sizeIdx, i, patch),
                        (i) => removeSizePackaging(sizeIdx, i),
                        packagingMaterials,
                        false,
                        sizePackagingCosts[sizeIdx] ?? [],
                        t.products.noPackagingMaterials
                      )}

                      {renderLiveStats(sizePreviews[sizeIdx] ?? null)}
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
