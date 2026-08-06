import { ChangeEvent, FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, patch, del, ApiError } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { useLangStore } from '../../store/langStore';
import { useT } from '../../i18n';

interface CompanyMe {
  name: string;
  industry: string | null;
  country: string | null;
  street: string | null;
  building_number: string | null;
  district: string | null;
  city: string | null;
  postal_code: string | null;
  commercial_registration_number: string | null;
  fiscal_year_end_month: number | null;
  contact_email: string | null;
  contact_phone: string | null;
  logo_base64: string | null;
  stamp_base64: string | null;
  inventory_enabled: boolean;
  delivery_notifications_enabled: boolean;
  two_factor_required: boolean;
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

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function CompanySection() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const [data, setData] = useState<CompanyMe | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<CompanyMe>>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  function load() {
    get<CompanyMe>('/company/me')
      .then((r) => {
        setData(r);
        setForm(r);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t.account.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleLogoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const b64 = await fileToBase64(file);
    try {
      await patch('/company/me', { logo_base64: b64 });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.account.saveFailed);
    }
  }

  async function handleStampChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const b64 = await fileToBase64(file);
    try {
      await patch('/company/me', { stamp_base64: b64 });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.account.saveFailed);
    }
  }

  async function handleSaveDetails(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      await patch('/company/me', {
        name: form.name,
        street: form.street ?? '',
        building_number: form.building_number ?? '',
        district: form.district ?? '',
        city: form.city ?? '',
        country: form.country || 'KW',
        postal_code: form.postal_code ?? '',
        commercial_registration_number: form.commercial_registration_number ?? '',
        fiscal_year_end_month: form.fiscal_year_end_month || 12,
        industry: form.industry ?? '',
        contact_email: form.contact_email ?? '',
        contact_phone: form.contact_phone ?? '',
      });
      setSuccess(t.account.saved);
      setEditing(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.account.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  async function togglePref(key: 'inventory_enabled' | 'delivery_notifications_enabled' | 'two_factor_required', value: boolean) {
    try {
      await patch('/company/me', { [key]: value });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.account.saveFailed);
    }
  }

  async function handleDelete() {
    if (!data || confirmName !== data.name) return;
    setDeleting(true);
    try {
      await del('/company/me', { confirm_name: confirmName });
    } catch {
      // even if the request errors after deletion started, fall through to logout
    }
    logout();
    navigate('/login');
  }

  if (!data) return <div className="muted">{t.common.loading}</div>;

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {success && <div className="success-banner">{success}</div>}

      <div className="card">
        <div className="card-head">
          <h2>{t.account.company.logo}</h2>
        </div>
        <div className="card-body" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {data.logo_base64 && <img src={data.logo_base64} alt="logo" style={{ width: 56, height: 56, borderRadius: 10, objectFit: 'cover' }} />}
          <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
            {t.account.company.uploadLogo}
            <input type="file" accept="image/*" onChange={handleLogoChange} style={{ display: 'none' }} />
          </label>
        </div>
      </div>

      <form onSubmit={handleSaveDetails}>
        <div className="card">
          <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>{t.account.company.details}</h2>
            {!editing && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
                {t.account.company.edit}
              </button>
            )}
          </div>
          <div className="card-body">
            <div className="field-grid">
              <div className="field">
                <label>{t.account.company.name}</label>
                <input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!editing} />
              </div>
              <div className="field">
                <label>{t.account.company.industry}</label>
                <input value={form.industry || ''} onChange={(e) => setForm({ ...form, industry: e.target.value })} disabled={!editing} />
              </div>
              <div className="field">
                <label>{t.account.company.street}</label>
                <input value={form.street || ''} onChange={(e) => setForm({ ...form, street: e.target.value })} disabled={!editing} />
              </div>
              <div className="field">
                <label>{t.account.company.buildingNumber}</label>
                <input value={form.building_number || ''} onChange={(e) => setForm({ ...form, building_number: e.target.value })} disabled={!editing} />
              </div>
              <div className="field">
                <label>{t.account.company.district}</label>
                <input value={form.district || ''} onChange={(e) => setForm({ ...form, district: e.target.value })} disabled={!editing} />
              </div>
              <div className="field">
                <label>{t.account.company.city}</label>
                <input value={form.city || ''} onChange={(e) => setForm({ ...form, city: e.target.value })} disabled={!editing} />
              </div>
              <div className="field">
                <label>{t.account.company.country}</label>
                <select value={form.country || 'KW'} onChange={(e) => setForm({ ...form, country: e.target.value })} disabled={!editing}>
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {lang === 'en' ? c.en : c.ar}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>{t.account.company.postalCode}</label>
                <input value={form.postal_code || ''} onChange={(e) => setForm({ ...form, postal_code: e.target.value })} disabled={!editing} />
              </div>
              <div className="field">
                <label>{t.account.company.crNumber}</label>
                <input
                  value={form.commercial_registration_number || ''}
                  onChange={(e) => setForm({ ...form, commercial_registration_number: e.target.value })}
                  disabled={!editing}
                />
              </div>
              <div className="field">
                <label>{t.account.company.fiscalYearEnd}</label>
                <select
                  value={form.fiscal_year_end_month || 12}
                  onChange={(e) => setForm({ ...form, fiscal_year_end_month: Number(e.target.value) })}
                  disabled={!editing}
                >
                  {(lang === 'en' ? MONTHS_EN : MONTHS_AR).map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>{t.account.company.contactEmail}</label>
                <input value={form.contact_email || ''} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} disabled={!editing} />
              </div>
              <div className="field">
                <label>{t.account.company.contactPhone}</label>
                <input value={form.contact_phone || ''} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} disabled={!editing} />
              </div>
            </div>
            {editing && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>
                  {saving ? t.common.loading : t.account.profile.save}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  onClick={() => {
                    setForm(data);
                    setEditing(false);
                  }}
                >
                  {t.account.profile.cancel}
                </button>
              </div>
            )}
          </div>
        </div>
      </form>

      <div className="card">
        <div className="card-head">
          <h2>{t.account.company.stamp}</h2>
        </div>
        <div className="card-body" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {data.stamp_base64 && <img src={data.stamp_base64} alt="stamp" style={{ width: 56, height: 56, borderRadius: 10, objectFit: 'cover' }} />}
          <div>
            <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
              {t.account.company.uploadLogo}
              <input type="file" accept="image/*" onChange={handleStampChange} style={{ display: 'none' }} />
            </label>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, maxWidth: 420 }}>{t.account.company.stampHint}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t.account.company.preferences}</h2>
        </div>
        <div className="card-body">
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            {t.account.company.preferencesHint}
          </p>
          {(
            [
              ['inventory_enabled', t.account.company.inventoryEnabled],
              ['delivery_notifications_enabled', t.account.company.deliveryNotifications],
              ['two_factor_required', t.account.company.twoFactorRequired],
            ] as const
          ).map(([key, label]) => (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 13 }}>{label}</span>
              <button
                type="button"
                className={`badge ${data[key] ? 'open' : 'closed'}`}
                style={{ cursor: 'pointer', border: 'none' }}
                onClick={() => togglePref(key, !data[key])}
              >
                {data[key] ? t.account.company.enabled : t.account.company.disabled}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ borderColor: 'var(--red-100)' }}>
        <div className="card-head">
          <h2 style={{ color: 'var(--red-600)' }}>{t.account.company.dangerZone}</h2>
        </div>
        <div className="card-body">
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            {t.account.company.dangerHint}
          </p>
          <div className="field" style={{ maxWidth: 320 }}>
            <label>{t.account.company.confirmPrompt}</label>
            <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={data.name} />
          </div>
          <button
            className="btn btn-danger btn-sm"
            type="button"
            disabled={confirmName !== data.name || deleting}
            onClick={handleDelete}
          >
            {deleting ? t.common.loading : t.account.company.confirmBtn}
          </button>
        </div>
      </div>
    </div>
  );
}
