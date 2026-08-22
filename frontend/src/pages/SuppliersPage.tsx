import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { IconPlus, IconEdit, IconTrash } from '../components/Icon';

interface Supplier {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
}

export default function SuppliersPage() {
  const t = useT();
  const [items, setItems] = useState<Supplier[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    get<{ suppliers: Supplier[] }>('/suppliers')
      .then((r) => setItems(r.suppliers))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.suppliers.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  function resetForm() {
    setName('');
    setContactName('');
    setPhone('');
    setEmail('');
    setNotes('');
  }

  function openCreate() {
    resetForm();
    setEditingId(null);
    setOpen(true);
  }

  function openEdit(s: Supplier) {
    setEditingId(s.id);
    setName(s.name);
    setContactName(s.contact_name || '');
    setPhone(s.phone || '');
    setEmail(s.email || '');
    setNotes(s.notes || '');
    setOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload = {
        name,
        contact_name: contactName || undefined,
        phone: phone || undefined,
        email: email || undefined,
        notes: notes || undefined,
      };
      if (editingId) {
        await patch(`/suppliers/${editingId}`, payload);
      } else {
        await post('/suppliers', payload);
      }
      resetForm();
      setEditingId(null);
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editingId ? t.suppliers.updateFailed : t.suppliers.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.suppliers.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/suppliers/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.suppliers.deleteFailed);
    }
  }

  return (
    <div>
      <PageHeader title={t.suppliers.title} subtitle={t.suppliers.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.suppliers.count(items.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.suppliers.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.suppliers.name}</th>
                <th>{t.suppliers.contactName}</th>
                <th>{t.suppliers.phone}</th>
                <th>{t.suppliers.email}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 700 }}>{s.name}</td>
                  <td>{s.contact_name || '—'}</td>
                  <td className="num">{s.phone || '—'}</td>
                  <td>{s.email || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="icon-btn" title={t.suppliers.editItem} onClick={() => openEdit(s)}>
                      <IconEdit />
                    </button>
                    <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(s.id)}>
                      <IconTrash />
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">{t.suppliers.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={editingId ? t.suppliers.editItem : t.suppliers.newItem}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="supplier-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="supplier-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.suppliers.name}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label>{t.suppliers.contactName}</label>
              <input value={contactName} onChange={(e) => setContactName(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.suppliers.phone}</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.suppliers.email}</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.suppliers.notes}</label>
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
