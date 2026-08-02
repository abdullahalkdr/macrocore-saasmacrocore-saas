import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { IconPlus, IconEdit, IconTrash } from '../components/Icon';

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  points: number;
  notes: string | null;
}

export default function CustomersPage() {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const isManager = user?.role === 'admin' || user?.role === 'manager';

  const [items, setItems] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [pointsTarget, setPointsTarget] = useState<Customer | null>(null);
  const [pointsDelta, setPointsDelta] = useState('');
  const [pointsLoading, setPointsLoading] = useState(false);

  function load() {
    const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
    get<{ customers: Customer[] }>(`/customers${qs}`)
      .then((r) => setItems(r.customers))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.customers.loadFailed));
  }

  useEffect(load, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  function resetForm() {
    setName('');
    setPhone('');
    setEmail('');
    setNotes('');
  }

  function openCreate() {
    resetForm();
    setEditingId(null);
    setOpen(true);
  }

  function openEdit(c: Customer) {
    setEditingId(c.id);
    setName(c.name);
    setPhone(c.phone || '');
    setEmail(c.email || '');
    setNotes(c.notes || '');
    setOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload = { name, phone: phone || undefined, email: email || undefined, notes: notes || undefined };
      if (editingId) {
        await patch(`/customers/${editingId}`, payload);
      } else {
        await post('/customers', payload);
      }
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editingId ? t.customers.updateFailed : t.customers.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.customers.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/customers/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.customers.deleteFailed);
    }
  }

  function openPoints(c: Customer) {
    setPointsTarget(c);
    setPointsDelta('');
  }

  async function submitPoints(e: FormEvent) {
    e.preventDefault();
    if (!pointsTarget) return;
    const delta = Number(pointsDelta);
    if (!delta) return;
    setError(null);
    setPointsLoading(true);
    try {
      await post(`/customers/${pointsTarget.id}/points`, { delta });
      setPointsTarget(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.customers.pointsFailed);
    } finally {
      setPointsLoading(false);
    }
  }

  return (
    <div>
      <PageHeader title={t.customers.title} subtitle={t.customers.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="field" style={{ maxWidth: 320 }}>
          <label>{t.customers.search}</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t.customers.searchPlaceholder} />
        </div>
      </div>

      <div className="section-title-row">
        <span className="muted">{t.customers.count(items.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.customers.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.customers.name}</th>
                <th>{t.customers.phone}</th>
                <th>{t.customers.email}</th>
                <th>{t.customers.points}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 700 }}>{c.name}</td>
                  <td className="num">{c.phone || '—'}</td>
                  <td>{c.email || '—'}</td>
                  <td className="num">{c.points}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => openPoints(c)}>
                      {t.customers.adjustPoints}
                    </button>
                    {isManager && (
                      <>
                        <button className="icon-btn" title={t.customers.editItem} onClick={() => openEdit(c)}>
                          <IconEdit />
                        </button>
                        <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(c.id)}>
                          <IconTrash />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">{t.customers.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={editingId ? t.customers.editItem : t.customers.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="customer-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                {t.common.cancel}
              </button>
            </>
          }
        >
          <form id="customer-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.customers.name}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label>{t.customers.phone}</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.customers.email}</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.customers.notes}</label>
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </form>
        </Modal>
      )}

      {pointsTarget && (
        <Modal
          title={`${t.customers.adjustPoints} — ${pointsTarget.name}`}
          onClose={() => setPointsTarget(null)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="points-form" disabled={pointsLoading}>
                {pointsLoading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setPointsTarget(null)}>
                {t.common.cancel}
              </button>
            </>
          }
        >
          <form id="points-form" onSubmit={submitPoints} className="field-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.customers.pointsHint}</label>
              <input
                type="number"
                step="1"
                value={pointsDelta}
                onChange={(e) => setPointsDelta(e.target.value)}
                placeholder={t.customers.pointsPlaceholder}
                autoFocus
              />
            </div>
            <div className="muted" style={{ gridColumn: '1 / -1' }}>
              {t.customers.currentPoints}: {pointsTarget.points}
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
