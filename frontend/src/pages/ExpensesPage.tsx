import { Fragment, FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useAuthStore } from '../store/authStore';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import { IconPlus, IconSettings, IconTrash, IconEdit } from '../components/Icon';
import { exportRowsToCsv } from '../utils/csv';

interface Expense {
  id: string;
  category: string;
  amount: number;
  description: string | null;
  receipt_image: string | null;
  location_id: string | null;
  location_name: string | null;
  expense_date: string | null;
  created_at: string;
  created_by_name: string | null;
}

interface Location {
  id: string;
  name: string;
  type: string;
}

const CATEGORY_OTHER = '__other__';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateKey(x: Expense): string {
  return (x.expense_date || x.created_at).slice(0, 10);
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ExpensesPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const user = useAuthStore((s) => s.user);
  const isManager = user?.role === 'admin' || user?.role === 'manager';
  const [items, setItems] = useState<Expense[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [dateFilter, setDateFilter] = useState('');

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState('');
  const [expenseDate, setExpenseDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [customCategory, setCustomCategory] = useState('');
  const [description, setDescription] = useState('');
  const [receiptBase64, setReceiptBase64] = useState<string | null>(null);
  const [receiptFileName, setReceiptFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [manageOpen, setManageOpen] = useState(false);
  const [categoriesDraft, setCategoriesDraft] = useState<string[]>([]);
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [categoriesLoading, setCategoriesLoading] = useState(false);

  function load() {
    const q = dateFilter ? `?date=${dateFilter}` : '';
    get<{ expenses: Expense[] }>(`/expenses${q}`)
      .then((r) => setItems(r.expenses))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.expenses.loadFailed));
  }

  useEffect(load, [dateFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    get<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
    get<{ expense_categories: string[] }>('/company/me')
      .then((r) => setCategories(Array.isArray(r.expense_categories) ? r.expense_categories : []))
      .catch(() => {});
  }, []);

  function resetForm() {
    setLocationId('');
    setExpenseDate(today());
    setAmount('');
    setCategory('');
    setCustomCategory('');
    setDescription('');
    setReceiptBase64(null);
    setReceiptFileName('');
  }

  function openCreate() {
    resetForm();
    setEditingId(null);
    setOpen(true);
  }

  function openEdit(x: Expense) {
    setEditingId(x.id);
    setLocationId(x.location_id || '');
    setExpenseDate(dateKey(x));
    setAmount(String(x.amount));
    setCategory(x.category);
    setCustomCategory('');
    setDescription(x.description || '');
    setReceiptBase64(null);
    setReceiptFileName('');
    setOpen(true);
  }

  async function handleFileChange(file: File | undefined) {
    if (!file) return;
    const base64 = await readFileAsBase64(file);
    setReceiptBase64(base64);
    setReceiptFileName(file.name);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const finalCategory = category === CATEGORY_OTHER ? customCategory.trim() : category;
    if (!finalCategory) {
      setError(t.expenses.saveFailed);
      return;
    }
    setLoading(true);
    try {
      const payload = {
        category: finalCategory,
        amount: Number(amount),
        description: description || undefined,
        location_id: locationId || undefined,
        expense_date: expenseDate || undefined,
        receipt_image: receiptBase64 || undefined,
      };
      if (editingId) {
        await patch(`/expenses/${editingId}`, payload);
      } else {
        await post('/expenses', payload);
      }
      resetForm();
      setEditingId(null);
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editingId ? t.expenses.updateFailed : t.expenses.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.expenses.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/expenses/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.expenses.deleteFailed);
    }
  }

  function exportCsv() {
    exportRowsToCsv(
      `expenses_${dateFilter || 'all'}.csv`,
      [t.expenses.date, t.expenses.category, t.expenses.location, t.expenses.recordedBy, t.expenses.description, t.expenses.amount],
      items.map((x) => [
        dateKey(x),
        x.category,
        x.location_name || '',
        x.created_by_name || '',
        x.description || '',
        Number(x.amount).toFixed(3),
      ])
    );
  }

  function openManage() {
    setCategoriesDraft(categories);
    setNewCategoryInput('');
    setCategoriesError(null);
    setManageOpen(true);
  }

  function addCategoryDraft() {
    const value = newCategoryInput.trim();
    if (!value || categoriesDraft.includes(value)) return;
    setCategoriesDraft([...categoriesDraft, value]);
    setNewCategoryInput('');
  }

  function removeCategoryDraft(idx: number) {
    setCategoriesDraft(categoriesDraft.filter((_, i) => i !== idx));
  }

  async function handleSaveCategories() {
    setCategoriesError(null);
    setCategoriesLoading(true);
    try {
      await patch('/company/me', { expense_categories: categoriesDraft });
      setCategories(categoriesDraft);
      setManageOpen(false);
    } catch (err) {
      setCategoriesError(err instanceof ApiError ? err.message : t.expenses.categoriesSaveFailed);
    } finally {
      setCategoriesLoading(false);
    }
  }

  function viewReceipt(base64: string) {
    const w = window.open();
    if (w) w.document.write(`<img src="${base64}" style="max-width:100%" />`);
  }

  // Category options for the form's select — includes whatever's currently being
  // edited even if it was since removed from (or never added to) the managed list,
  // so opening an old expense for edit never shows a blank/mismatched dropdown.
  const categoryOptions = category && category !== CATEGORY_OTHER && !categories.includes(category) ? [...categories, category] : categories;

  // "This month" stat cards — one per category plus a grand total, computed from
  // whatever's already loaded (independent of the single-day filter above).
  const now = new Date();
  const monthItems = items.filter((x) => {
    const d = new Date(dateKey(x));
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const monthByCategory = monthItems.reduce<Record<string, number>>((acc, x) => {
    acc[x.category] = (acc[x.category] || 0) + Number(x.amount);
    return acc;
  }, {});
  const monthTotal = monthItems.reduce((sum, x) => sum + Number(x.amount), 0);

  // Group rows by date for the "date header row, then that day's expenses" layout.
  const dateFormatter = new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const groups: { key: string; items: Expense[] }[] = [];
  for (const x of items) {
    const key = dateKey(x);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(x);
    else groups.push({ key, items: [x] });
  }

  const colCount = isManager ? 7 : 6;

  return (
    <div>
      <PageHeader title={t.expenses.title} subtitle={t.expenses.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="stat-grid" style={{ marginBottom: 16 }}>
        {Object.entries(monthByCategory).map(([cat, sum]) => (
          <div className="stat-card" key={cat}>
            <div className="stat-label">{cat}</div>
            <div className="stat-value">{sum.toFixed(3)} KD</div>
          </div>
        ))}
        <div className="stat-card">
          <div className="stat-label">{t.expenses.currentMonthTotal}</div>
          <div className="stat-value" style={{ color: 'var(--danger)' }}>{monthTotal.toFixed(3)} KD</div>
        </div>
      </div>

      <div className="section-title-row">
        <span className="muted">{t.expenses.count(items.length, dateFilter || undefined)}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={exportCsv}>
            {t.expenses.exportCsv}
          </button>
          <button className="btn btn-primary btn-sm" onClick={openCreate}>
            <IconPlus /> {t.expenses.newItem}
          </button>
          {isManager && (
            <button className="btn btn-secondary btn-sm" onClick={openManage}>
              <IconSettings size={13} /> {t.expenses.manageCategories}
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="field" style={{ maxWidth: 200, marginBottom: 14 }}>
          <label>{t.expenses.filterByDate}</label>
          <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} />
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.expenses.category}</th>
                <th>{t.expenses.recordedBy}</th>
                <th>{t.expenses.location}</th>
                <th>{t.expenses.description}</th>
                <th className="num">{t.expenses.amount}</th>
                <th>{t.expenses.receiptImage}</th>
                {isManager && <th></th>}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.key}>
                  <tr>

                    <td colSpan={colCount} style={{ background: 'var(--surface-alt)', fontWeight: 800, fontSize: 12 }}>
                      {dateFormatter.format(new Date(g.key))}
                    </td>
                  </tr>
                  {g.items.map((x) => (
                    <tr key={x.id}>
                      <td>
                        <Tag color="amber">{x.category}</Tag>
                      </td>
                      <td>{x.created_by_name || '—'}</td>
                      <td>{x.location_name || '—'}</td>
                      <td>{x.description || '—'}</td>
                      <td className="num" style={{ color: 'var(--danger)', fontWeight: 700 }}>
                        {Number(x.amount).toFixed(3)} KD
                      </td>
                      <td>
                        {x.receipt_image ? (
                          <a href="#" onClick={(e) => { e.preventDefault(); viewReceipt(x.receipt_image as string); }}>
                            {t.expenses.viewReceipt}
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                      {isManager && (
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button className="icon-btn" title={t.expenses.editItem} onClick={() => openEdit(x)}>
                              <IconEdit />
                            </button>
                            <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(x.id)}>
                              <IconTrash />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </Fragment>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={colCount}>
                    <div className="empty-state">{t.expenses.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={editingId ? t.expenses.editItem : t.expenses.newItem}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="expense-form" disabled={loading}>
                {loading ? t.common.loading : editingId ? t.expenses.saveEdit : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="expense-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.expenses.location}</label>
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">{t.expenses.selectPlaceholder}</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.expenses.date}</label>
              <input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} required />
            </div>
            <div className="field">
              <label>{t.expenses.amount}</label>
              <input type="number" step="0.001" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label>{t.expenses.category}</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)} required>
                <option value="" disabled>
                  {t.expenses.selectPlaceholder}
                </option>
                {categoryOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                <option value={CATEGORY_OTHER}>{t.expenses.categoryOther}</option>
              </select>
            </div>
            {category === CATEGORY_OTHER && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <input
                  value={customCategory}
                  onChange={(e) => setCustomCategory(e.target.value)}
                  placeholder={t.expenses.categoryCustomPlaceholder}
                  required
                  autoFocus
                />
              </div>
            )}
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.expenses.description}</label>
              <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.expenses.receiptImage}</label>
              <input type="file" accept="image/*" onChange={(e) => handleFileChange(e.target.files?.[0])} />
              {receiptFileName && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{receiptFileName}</div>}
              {editingId && !receiptFileName && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{t.expenses.receiptReplaceHint}</div>}
            </div>
          </form>
        </Modal>
      )}

      {manageOpen && (
        <Modal
          title={t.expenses.manageCategoriesTitle}
          onClose={() => setManageOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="button" onClick={handleSaveCategories} disabled={categoriesLoading}>
                {categoriesLoading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          {categoriesError && <div className="error-banner">{categoriesError}</div>}
          {categoriesDraft.length === 0 && <div className="empty-state">{t.expenses.noCategories}</div>}
          {categoriesDraft.map((c, idx) => (
            <div className="invite-row" key={`${c}-${idx}`}>
              <span>{c}</span>
              <button type="button" className="icon-btn" onClick={() => removeCategoryDraft(idx)}>
                <IconTrash />
              </button>
            </div>
          ))}
          <div className="field" style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={newCategoryInput}
                onChange={(e) => setNewCategoryInput(e.target.value)}
                placeholder={t.expenses.addCategoryPlaceholder}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCategoryDraft();
                  }
                }}
              />
              <button type="button" className="btn btn-secondary btn-sm" onClick={addCategoryDraft}>
                {t.expenses.addBtn}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
