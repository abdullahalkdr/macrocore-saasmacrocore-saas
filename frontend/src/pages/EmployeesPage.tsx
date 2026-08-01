import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import Avatar from '../components/Avatar';
import { IconPlus } from '../components/Icon';

interface Certificate {
  name: string;
  name_en?: string;
  issued_date?: string;
  file_base64?: string;
}

interface Employee {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  job_role: string | null;
  salary_monthly: number | null;
  status: string;
  photo_base64: string | null;
  civil_id: string | null;
  birth_date: string | null;
  weight_kg: number | null;
  prior_experience: string | null;
  certificates: Certificate[];
  age: number | null;
  wage_type: 'monthly' | 'hourly';
  hourly_rate: number | null;
  start_date: string | null;
  nationality: string | null;
  civil_id_expiry: string | null;
  residency_number: string | null;
  residency_expiry: string | null;
  passport_number: string | null;
  passport_expiry: string | null;
  bank_iban: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  days_until_civil_id_expiry: number | null;
  days_until_residency_expiry: number | null;
  days_until_passport_expiry: number | null;
}

function hasExpiryWarning(e: Employee): boolean {
  return [e.days_until_civil_id_expiry, e.days_until_residency_expiry, e.days_until_passport_expiry].some(
    (d) => d !== null && d <= 30
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function emptyForm() {
  return {
    name: '',
    email: '',
    phone: '',
    jobRole: '',
    salary: '',
    photoBase64: '' as string | null,
    civilId: '',
    birthDate: '',
    weightKg: '',
    priorExperience: '',
    certificates: [] as Certificate[],
    wageType: 'monthly' as 'monthly' | 'hourly',
    hourlyRate: '',
    startDate: '',
    nationality: '',
    civilIdExpiry: '',
    residencyNumber: '',
    residencyExpiry: '',
    passportNumber: '',
    passportExpiry: '',
    bankIban: '',
    emergencyContactName: '',
    emergencyContactPhone: '',
  };
}

function calcAge(birthDate: string): number | null {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  if (isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const hadBirthday = now.getMonth() > birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() >= birth.getDate());
  if (!hadBirthday) age -= 1;
  return age;
}

export default function EmployeesPage() {
  const t = useT();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    get<{ employees: Employee[] }>('/employees')
      .then((r) => setEmployees(r.employees))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.employees.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setOpen(true);
  }

  function openEdit(emp: Employee) {
    setEditingId(emp.id);
    setForm({
      name: emp.name,
      email: emp.email || '',
      phone: emp.phone || '',
      jobRole: emp.job_role || '',
      salary: emp.salary_monthly !== null ? String(emp.salary_monthly) : '',
      photoBase64: emp.photo_base64,
      civilId: emp.civil_id || '',
      birthDate: emp.birth_date ? emp.birth_date.slice(0, 10) : '',
      weightKg: emp.weight_kg !== null ? String(emp.weight_kg) : '',
      priorExperience: emp.prior_experience || '',
      certificates: emp.certificates || [],
      wageType: emp.wage_type || 'monthly',
      hourlyRate: emp.hourly_rate !== null ? String(emp.hourly_rate) : '',
      startDate: emp.start_date ? emp.start_date.slice(0, 10) : '',
      nationality: emp.nationality || '',
      civilIdExpiry: emp.civil_id_expiry ? emp.civil_id_expiry.slice(0, 10) : '',
      residencyNumber: emp.residency_number || '',
      residencyExpiry: emp.residency_expiry ? emp.residency_expiry.slice(0, 10) : '',
      passportNumber: emp.passport_number || '',
      passportExpiry: emp.passport_expiry ? emp.passport_expiry.slice(0, 10) : '',
      bankIban: emp.bank_iban || '',
      emergencyContactName: emp.emergency_contact_name || '',
      emergencyContactPhone: emp.emergency_contact_phone || '',
    });
    setOpen(true);
  }

  async function handlePhotoChange(file: File | undefined) {
    if (!file) return;
    const base64 = await readFileAsBase64(file);
    setForm((f) => ({ ...f, photoBase64: base64 }));
  }

  function addCertificate() {
    setForm((f) => ({ ...f, certificates: [...f.certificates, { name: '' }] }));
  }
  function updateCertificate(i: number, patchObj: Partial<Certificate>) {
    setForm((f) => ({ ...f, certificates: f.certificates.map((c, idx) => (idx === i ? { ...c, ...patchObj } : c)) }));
  }
  function removeCertificate(i: number) {
    setForm((f) => ({ ...f, certificates: f.certificates.filter((_, idx) => idx !== i) }));
  }
  async function handleCertificateFile(i: number, file: File | undefined) {
    if (!file) return;
    const base64 = await readFileAsBase64(file);
    updateCertificate(i, { file_base64: base64 });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload = {
        name: form.name,
        email: form.email || undefined,
        phone: form.phone || undefined,
        job_role: form.jobRole || undefined,
        salary_monthly: form.salary ? Number(form.salary) : undefined,
        photo_base64: form.photoBase64 || undefined,
        civil_id: form.civilId || undefined,
        birth_date: form.birthDate || undefined,
        weight_kg: form.weightKg ? Number(form.weightKg) : undefined,
        prior_experience: form.priorExperience || undefined,
        certificates: form.certificates.filter((c) => c.name.trim()),
        wage_type: form.wageType,
        hourly_rate: form.wageType === 'hourly' && form.hourlyRate ? Number(form.hourlyRate) : undefined,
        start_date: form.startDate || undefined,
        nationality: form.nationality || undefined,
        civil_id_expiry: form.civilIdExpiry || undefined,
        residency_number: form.residencyNumber || undefined,
        residency_expiry: form.residencyExpiry || undefined,
        passport_number: form.passportNumber || undefined,
        passport_expiry: form.passportExpiry || undefined,
        bank_iban: form.bankIban || undefined,
        emergency_contact_name: form.emergencyContactName || undefined,
        emergency_contact_phone: form.emergencyContactPhone || undefined,
      };
      if (editingId) {
        await patch(`/employees/${editingId}`, payload);
      } else {
        await post('/employees', payload);
      }
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.employees.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  const liveAge = calcAge(form.birthDate);

  return (
    <div>
      <PageHeader title={t.employees.title} subtitle={t.employees.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      {employees.filter(hasExpiryWarning).length > 0 && (
        <div style={{ padding: '12px', backgroundColor: '#ffe6e6', borderLeft: '4px solid #e74c3c', marginBottom: '16px', borderRadius: '4px' }}>
          <strong>{t.employees.expiryAlert(employees.filter(hasExpiryWarning).length)}</strong>
        </div>
      )}

      <div className="section-title-row">
        <span className="muted">{t.employees.count(employees.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.employees.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th></th>
                <th>{t.employees.name}</th>
                <th>{t.employees.jobRole}</th>
                <th>{t.employees.wageType}</th>
                <th className="num">{t.employees.salary}</th>
                <th>{t.employees.status}</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id} onClick={() => openEdit(e)} style={{ cursor: 'pointer' }}>
                  <td>
                    {e.photo_base64 ? (
                      <img src={e.photo_base64} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} />
                    ) : (
                      <Avatar name={e.name} />
                    )}
                  </td>
                  <td style={{ fontWeight: 700 }}>
                    {e.name}
                    {e.age !== null && <span className="muted" style={{ fontWeight: 400 }}> ({e.age})</span>}
                    {hasExpiryWarning(e) && (
                      <>
                        {' '}
                        <Tag color="amber">{t.employees.expiringBadge}</Tag>
                      </>
                    )}
                  </td>
                  <td>{e.job_role || '—'}</td>
                  <td>{e.wage_type === 'hourly' ? t.employees.hourly : t.employees.monthly}</td>
                  <td className="num">
                    {e.wage_type === 'hourly'
                      ? e.hourly_rate !== null
                        ? t.employees.hourlyRateShort(Number(e.hourly_rate).toFixed(3))
                        : '—'
                      : e.salary_monthly !== null
                        ? `${Number(e.salary_monthly).toFixed(3)} KD`
                        : '—'}
                  </td>
                  <td>{e.status === 'active' ? <Tag color="green">{t.common.active}</Tag> : <Tag color="gray">{e.status}</Tag>}</td>
                </tr>
              ))}
              {employees.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">{t.employees.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={editingId ? form.name || t.employees.newItem : t.employees.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="employee-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                {t.common.cancel}
              </button>
            </>
          }
        >
          <form id="employee-form" onSubmit={handleSubmit}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              {form.photoBase64 ? (
                <img src={form.photoBase64} alt="" style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover' }} />
              ) : (
                <Avatar name={form.name || '?'} />
              )}
              <input type="file" accept="image/*" onChange={(e) => handlePhotoChange(e.target.files?.[0])} />
            </div>

            <div className="field-grid">
              <div className="field">
                <label>{t.employees.name}</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
              </div>
              <div className="field">
                <label>{t.employees.jobRole}</label>
                <input value={form.jobRole} onChange={(e) => setForm({ ...form, jobRole: e.target.value })} placeholder={t.employees.jobRolePlaceholder} />
              </div>
              <div className="field">
                <label>{t.employees.wageType}</label>
                <select
                  value={form.wageType}
                  onChange={(e) => setForm({ ...form, wageType: e.target.value as 'monthly' | 'hourly' })}
                >
                  <option value="monthly">{t.employees.wageTypeMonthly}</option>
                  <option value="hourly">{t.employees.wageTypeHourly}</option>
                </select>
              </div>
              {form.wageType === 'hourly' ? (
                <div className="field">
                  <label>{t.employees.hourlyRate}</label>
                  <input
                    type="number"
                    step="0.001"
                    value={form.hourlyRate}
                    onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })}
                  />
                </div>
              ) : (
                <div className="field">
                  <label>{t.employees.salary}</label>
                  <input type="number" step="0.001" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} />
                </div>
              )}
              <div className="field">
                <label>{t.employees.phone}</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.email}</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.civilId}</label>
                <input value={form.civilId} onChange={(e) => setForm({ ...form, civilId: e.target.value })} />
              </div>
              <div className="field">
                <label>
                  {t.employees.birthDate}
                  {liveAge !== null && <span className="muted"> ({t.employees.age(liveAge)})</span>}
                </label>
                <input type="date" value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.weight}</label>
                <input type="number" step="0.1" value={form.weightKg} onChange={(e) => setForm({ ...form, weightKg: e.target.value })} />
              </div>
            </div>

            <div className="field" style={{ marginTop: 10 }}>
              <label>{t.employees.priorExperience}</label>
              <textarea
                rows={2}
                value={form.priorExperience}
                onChange={(e) => setForm({ ...form, priorExperience: e.target.value })}
              />
            </div>

            <div className="hr" />
            <div className="section-title-row">
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.employees.hrSectionTitle}</span>
            </div>
            <div className="field-grid">
              <div className="field">
                <label>{t.employees.nationality}</label>
                <input value={form.nationality} onChange={(e) => setForm({ ...form, nationality: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.joinDate}</label>
                <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.civilIdExpiry}</label>
                <input type="date" value={form.civilIdExpiry} onChange={(e) => setForm({ ...form, civilIdExpiry: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.residencyNumber}</label>
                <input value={form.residencyNumber} onChange={(e) => setForm({ ...form, residencyNumber: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.residencyExpiry}</label>
                <input type="date" value={form.residencyExpiry} onChange={(e) => setForm({ ...form, residencyExpiry: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.passportNumber}</label>
                <input value={form.passportNumber} onChange={(e) => setForm({ ...form, passportNumber: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.passportExpiry}</label>
                <input type="date" value={form.passportExpiry} onChange={(e) => setForm({ ...form, passportExpiry: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.bankIban}</label>
                <input value={form.bankIban} onChange={(e) => setForm({ ...form, bankIban: e.target.value })} />
              </div>
            </div>

            <div className="hr" />
            <div className="section-title-row">
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.employees.emergencyContactTitle}</span>
            </div>
            <div className="field-grid">
              <div className="field">
                <label>{t.employees.emergencyContactName}</label>
                <input value={form.emergencyContactName} onChange={(e) => setForm({ ...form, emergencyContactName: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.emergencyContactPhone}</label>
                <input value={form.emergencyContactPhone} onChange={(e) => setForm({ ...form, emergencyContactPhone: e.target.value })} />
              </div>
            </div>

            <div className="hr" />
            <div className="section-title-row">
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.employees.certificatesTitle}</span>
              <button className="btn btn-secondary btn-sm" type="button" onClick={addCertificate}>
                <IconPlus /> {t.employees.addCertificate}
              </button>
            </div>
            {form.certificates.map((c, i) => (
              <div key={i} className="form-row" style={{ marginBottom: 8 }}>
                <div className="field" style={{ flex: 2 }}>
                  <input
                    placeholder={t.employees.certificateName}
                    value={c.name}
                    onChange={(e) => updateCertificate(i, { name: e.target.value })}
                  />
                </div>
                <div className="field">
                  <input type="date" value={c.issued_date || ''} onChange={(e) => updateCertificate(i, { issued_date: e.target.value })} />
                </div>
                <div className="field">
                  <input type="file" onChange={(e) => handleCertificateFile(i, e.target.files?.[0])} />
                </div>
                <button className="icon-btn" type="button" onClick={() => removeCertificate(i)} style={{ alignSelf: 'center' }}>
                  ×
                </button>
              </div>
            ))}
          </form>
        </Modal>
      )}
    </div>
  );
}
