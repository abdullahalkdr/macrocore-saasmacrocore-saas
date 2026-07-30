import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { IconPlus } from '../components/Icon';

interface Location {
  id: string;
  name: string;
  address: string | null;
  area: string | null;
  type: 'kiosk' | 'warehouse';
}

const TYPE_LABELS: Record<string, string> = { kiosk: 'كشك', warehouse: 'مستودع' };

export default function LocationsPage() {
  const t = useT();
  const [items, setItems] = useState<Location[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [area, setArea] = useState('');
  const [type, setType] = useState<'kiosk' | 'warehouse'>('kiosk');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    get<{ locations: Location[] }>('/locations')
      .then((r) => setItems(r.locations))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.locations.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  function resetForm() {
    setName('');
    setAddress('');
    setArea('');
    setType('kiosk');
    setEditingId(null);
  }

  function openEditModal(loc: Location) {
    setEditingId(loc.id);
    setName(loc.name);
    setAddress(loc.address || '');
    setArea(loc.area || '');
    setType(loc.type);
    setOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (editingId) {
        await patch(`/locations/${editingId}`, { name, address: address || undefined, area: area || undefined, type });
      } else {
        await post('/locations', { name, address: address || undefined, area: area || undefined, type });
      }
      resetForm();
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.locations.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader title={t.locations.title} subtitle={t.locations.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.locations.count(items.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={() => { resetForm(); setOpen(true); }}>
          <IconPlus /> {t.locations.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.locations.name}</th>
                <th>النوع</th>
                <th>{t.locations.area}</th>
                <th>{t.locations.address}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((l) => (
                <tr key={l.id}>
                  <td style={{ fontWeight: 700 }}>{l.name}</td>
                  <td>
                    <span
                      style={{
                        padding: '2px 10px',
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 700,
                        backgroundColor: l.type === 'warehouse' ? '#e8f0fe' : '#fff4e5',
                        color: l.type === 'warehouse' ? '#1a56db' : '#b45309',
                      }}
                    >
                      {TYPE_LABELS[l.type] || l.type}
                    </span>
                  </td>
                  <td>{l.area || '—'}</td>
                  <td>{l.address || '—'}</td>
                  <td>
                    <button className="btn btn-sm" onClick={() => openEditModal(l)}>تعديل</button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">{t.locations.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={editingId ? 'تعديل الموقع' : t.locations.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="location-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                {t.common.cancel}
              </button>
            </>
          }
        >
          <form id="location-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.locations.name}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label>النوع</label>
              <select value={type} onChange={(e) => setType(e.target.value as 'kiosk' | 'warehouse')}>
                <option value="kiosk">كشك</option>
                <option value="warehouse">مستودع</option>
              </select>
            </div>
            <div className="field">
              <label>{t.locations.area}</label>
              <input value={area} onChange={(e) => setArea(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.locations.address}</label>
              <input value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
