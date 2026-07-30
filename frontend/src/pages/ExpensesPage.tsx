import { FormEvent, useEffect, useState } from 'react';
import { get, post, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { IconPlus } from '../components/Icon';

interface Expense {
  id: string;
  category: string;
  amount: number;
  description: string | null;
  created_at: string;
}

export default function ExpensesPage() {
  const t = useT();
  const [items, setItems] = useState<Expense[]>([]);
  const [dateFilter, setDateFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    const q = dateFilter ? `?date=${dateFilter}` : '';
    get<{ expenses: Expense[] }>(`/expenses${q}`)
      .then((r) => setItems(r.expenses))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.expenses.loadFailed));
  }

  useEffect(load, [dateFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await post('/expenses', { category, amount: Number(amount), description: description || undefined });
      setCategory('');
      setAmount('');
      setDescription('');
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.expenses.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader title={t.expenses.title} subtitle={t.expenses.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.expenses.count(items.length, dateFilter || undefined)}</span>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          <IconPlus /> {t.expenses.newItem}
        </button>
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
                <th>{t.reports.date}</th>
                <th>{t.expenses.category}</th>
                <th className="num">{t.expenses.amount}</th>
                <th>{t.expenses.description}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((x) => (
                <tr key={x.id}>
                  <td>{new Date(x.created_at).toLocaleDateString()}</td>
                  <td style={{ fontWeight: 700 }}>{x.category}</td>
                  <td className="num">{Number(x.amount).toFixed(3)} KD</td>
                  <td>{x.description || '—'}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={4}>
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
          title={t.expenses.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="expense-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                {t.common.cancel}
              </button>
            </>
          }
        >
          <form id="expense-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.expenses.category}</label>
              <input value={category} onChange={(e) => setCategory(e.target.value)} required autoFocus placeholder="rent, supplies..." />
            </div>
            <div className="field">
              <label>{t.expenses.amount}</label>
              <input type="number" step="0.001" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.expenses.description}</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
