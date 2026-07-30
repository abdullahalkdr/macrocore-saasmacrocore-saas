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
                <th>نظام الأجر</th>
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
                  </td>
                  <td>{e.job_role || '—'}</td>
                  <td>{e.wage_type === 'hourly' ? 'بالساعة' : 'شهري'}</td>
                  <td className="num">
                    {e.wage_type === 'hourly'
                      ? e.hourly_rate !== null
                        ? `${Number(e.hourly_rate).toFixed(3)} KD/ساعة`
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
                <input value={form.jobRole} onChange={(e) => setForm({ ...form, jobRole: e.target.value })} placeholder="cashier..." />
              </div>
              <div className="field">
                <label>نظام الأجر</label>
                <select
                  value={form.wageType}
                  onChange={(e) => setForm({ ...form, wageType: e.target.value as 'monthly' | 'hourly' })}
                >
                  <option value="monthly">راتب شهري</option>
                  <option value="hourly">أجر بالساعة</option>
                </select>
              </div>
              {form.wageType === 'hourly' ? (
                <div className="field">
                  <label>سعر الساعة (KD)</label>
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
