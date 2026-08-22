import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import FullScreenDoc from '../components/FullScreenDoc';
import { IconPlus, IconEdit, IconTrash } from '../components/Icon';

interface Customer {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  points: number;
  notes: string | null;
  relation: 'customer' | 'vendor' | 'both';
  country: string | null;
  city: string | null;
  street: string | null;
  building_number: string | null;
  district: string | null;
  postal_code: string | null;
  contact_person: string | null;
  payment_terms: string | null;
  commercial_registration_number: string | null;
}

const COUNTRIES = [
  { code: 'KW', ar: 'الكويت', en: 'Kuwait' },
  { code: 'SA', ar: 'المملكة العربية السعودية', en: 'Saudi Arabia' },
  { code: 'AE', ar: 'الإمارات العربية المتحدة', en: 'United Arab Emirates' },
  { code: 'QA', ar: 'قطر', en: 'Qatar' },
  { code: 'BH', ar: 'البحرين', en: 'Bahrain' },
  { code: 'OM', ar: 'عُمان', en: 'Oman' },
  { code: 'EG', ar: 'مصر', en: 'Egypt' },
];

const emptyForm = {
  name: '',
  relation: 'customer' as Customer['relation'],
  country: 'KW',
  commercial_registration_number: '',
  city: '',
  street: '',
  building_number: '',
  district: '',
  postal_code: '',
  email: '',
  phone: '',
  contact_person: '',
  payment_terms: '',
  notes: '',
};

export default function CustomersPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const user = useAuthStore((s) => s.user);
  const isManager = user?.role === 'admin' || user?.role === 'manager';

  const [items, setItems] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
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

  function openCreate() {
    setForm(emptyForm);
    setEditingId(null);
    setOpen(true);
  }

  function openEdit(c: Customer) {
    setEditingId(c.id);
    setForm({
      name: c.name,
      relation: c.relation || 'customer',
      country: c.country || 'KW',
      commercial_registration_number: c.commercial_registration_number || '',
      city: c.city || '',
      street: c.street || '',
      building_number: c.building_number || '',
      district: c.district || '',
      postal_code: c.postal_code || '',
      email: c.email || '',
      phone: c.phone || '',
      contact_person: c.contact_person || '',
      payment_terms: c.payment_terms || '',
      notes: c.notes || '',
    });
    setOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload = { ...form };
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

  function relationLabel(r: Customer['relation']) {
    return t.customers.relationValues[r] ?? r;
  }
  function countryLabel(code: string | null) {
    const c = COUNTRIES.find((x) => x.code === code);
    if (!c) return code || '—';
    return lang === 'en' ? c.en : c.ar;
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
                <th>{t.customers.code}</th>
                <th>{t.customers.name}</th>
                <th>{t.customers.contactPerson}</th>
                <th>{t.customers.email}</th>
                <th>{t.customers.phone}</th>
                <th>{t.customers.relation}</th>
                <th>{t.customers.country}</th>
                <th>{t.customers.city}</th>
                <th>{t.customers.points}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td className="num">{c.code}</td>
                  <td style={{ fontWeight: 700 }}>{c.name}</td>
                  <td>{c.contact_person || '—'}</td>
                  <td>{c.email || '—'}</td>
                  <td className="num">{c.phone || '—'}</td>
                  <td>
                    <span className="tag gray">{relationLabel(c.relation)}</span>
                  </td>
                  <td>{countryLabel(c.country)}</td>
                  <td>{c.city || '—'}</td>
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
                  <td colSpan={10}>
                    <div className="empty-state">{t.customers.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <FullScreenDoc
          title={editingId ? t.customers.editItem : t.customers.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary btn-sm" type="submit" form="customer-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setOpen(false)}>
                {t.common.cancel}
              </button>
            </>
          }
        >
          <form id="customer-form" onSubmit={handleSubmit}>
            <div className="card">
              <div className="card-head">
                <h2>{t.customers.sectionEstablishment}</h2>
              </div>
              <div className="card-body field-grid">
                <div className="field">
                  <label>{t.customers.name} *</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
                </div>
                <div className="field">
                  <label>{t.customers.country}</label>
                  <select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {lang === 'en' ? c.en : c.ar}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>{t.customers.crNumber}</label>
                  <input
                    value={form.commercial_registration_number}
                    onChange={(e) => setForm({ ...form, commercial_registration_number: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h2>{t.customers.sectionAddress}</h2>
              </div>
              <div className="card-body field-grid">
                <div className="field">
                  <label>{t.customers.city}</label>
                  <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                </div>
                <div className="field">
                  <label>{t.customers.street}</label>
                  <input value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} />
                </div>
                <div className="field">
                  <label>{t.customers.buildingNumber}</label>
                  <input value={form.building_number} onChange={(e) => setForm({ ...form, building_number: e.target.value })} />
                </div>
                <div className="field">
                  <label>{t.customers.district}</label>
                  <input value={form.district} onChange={(e) => setForm({ ...form, district: e.target.value })} />
                </div>
                <div className="field">
                  <label>{t.customers.postalCode}</label>
                  <input value={form.postal_code} onChange={(e) => setForm({ ...form, postal_code: e.target.value })} />
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h2>{t.customers.sectionContact}</h2>
              </div>
              <div className="card-body field-grid">
                <div className="field">
                  <label>{t.customers.contactPerson}</label>
                  <input value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} />
                </div>
                <div className="field">
                  <label>{t.customers.email}</label>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
                <div className="field">
                  <label>{t.customers.phone}</label>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div className="field">
                  <label>{t.customers.relation}</label>
                  <select value={form.relation} onChange={(e) => setForm({ ...form, relation: e.target.value as Customer['relation'] })}>
                    <option value="customer">{t.customers.relationValues.customer}</option>
                    <option value="vendor">{t.customers.relationValues.vendor}</option>
                    <option value="both">{t.customers.relationValues.both}</option>
                  </select>
                </div>
                <div className="field">
                  <label>{t.customers.paymentTerms}</label>
                  <input
                    value={form.payment_terms}
                    onChange={(e) => setForm({ ...form, payment_terms: e.target.value })}
                    placeholder={t.customers.paymentTermsPlaceholder}
                  />
                </div>
                <div className="field" style={{ gridColumn: '1 / -1' }}>
                  <label>{t.customers.notes}</label>
                  <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </div>
              </div>
            </div>
          </form>
        </FullScreenDoc>
      )}

      {pointsTarget && (
        <Modal
          title={`${t.customers.adjustPoints} — ${pointsTarget.name}`}
          onClose={() => setPointsTarget(null)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="points-form" disabled={pointsLoading}>
                {pointsLoading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
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
