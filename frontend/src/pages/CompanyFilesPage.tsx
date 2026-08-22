import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { IconPlus } from '../components/Icon';

type Category = 'license' | 'contract' | 'certificate' | 'other';

interface CompanyFile {
  id: string;
  title: string;
  category: Category;
  file_name: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  notes: string | null;
  days_until_expiry: number | null;
  created_at: string;
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
    title: '',
    category: 'license' as Category,
    fileBase64: '' as string | null,
    fileName: '',
    issueDate: '',
    expiryDate: '',
    notes: '',
  };
}

export default function CompanyFilesPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const CATEGORY_LABELS: Record<Category, string> = {
    license: t.companyFiles.categoryLicense,
    contract: t.companyFiles.categoryContract,
    certificate: t.companyFiles.categoryCertificate,
    other: t.companyFiles.categoryOther,
  };
  const [files, setFiles] = useState<CompanyFile[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    get<{ files: CompanyFile[] }>('/company-files')
      .then((r) => setFiles(r.files))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.companyFiles.loadFailed));
  }

  useEffect(load, []);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setOpen(true);
  }

  function openEdit(f: CompanyFile) {
    setEditingId(f.id);
    setForm({
      title: f.title,
      category: f.category,
      fileBase64: null,
      fileName: f.file_name || '',
      issueDate: f.issue_date ? f.issue_date.slice(0, 10) : '',
      expiryDate: f.expiry_date ? f.expiry_date.slice(0, 10) : '',
      notes: f.notes || '',
    });
    setOpen(true);
  }

  async function handleFileChange(file: File | undefined) {
    if (!file) return;
    const base64 = await readFileAsBase64(file);
    setForm((f) => ({ ...f, fileBase64: base64, fileName: file.name }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload = {
        title: form.title,
        category: form.category,
        file_base64: form.fileBase64 || undefined,
        file_name: form.fileName || undefined,
        issue_date: form.issueDate || undefined,
        expiry_date: form.expiryDate || undefined,
        notes: form.notes || undefined,
      };
      if (editingId) {
        await patch(`/company-files/${editingId}`, payload);
      } else {
        await post('/company-files', payload);
      }
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.companyFiles.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.companyFiles.deleteConfirm)) return;
    try {
      await del(`/company-files/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.companyFiles.deleteFailed);
    }
  }

  async function handleDownload(f: CompanyFile) {
    try {
      const r = await get<{ file: CompanyFile & { file_base64: string | null } }>(`/company-files/${f.id}`);
      if (!r.file.file_base64) {
        setError(t.companyFiles.noFileUploaded);
        return;
      }
      const a = document.createElement('a');
      a.href = r.file.file_base64;
      a.download = r.file.file_name || f.title;
      a.click();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.companyFiles.downloadFailed);
    }
  }

  function getExpiryStatus(f: CompanyFile): 'expired' | 'expiring' | 'safe' {
    if (f.days_until_expiry === null) return 'safe';
    if (f.days_until_expiry < 0) return 'expired';
    if (f.days_until_expiry <= 30) return 'expiring';
    return 'safe';
  }
  function getStatusColor(status: 'expired' | 'expiring' | 'safe'): string {
    if (status === 'expired') return '#e74c3c';
    if (status === 'expiring') return '#f39c12';
    return '#27ae60';
  }

  const expiringFiles = files.filter((f) => getExpiryStatus(f) !== 'safe');
  const otherFiles = files.filter((f) => getExpiryStatus(f) === 'safe');

  return (
    <div>
      <PageHeader title={t.companyFiles.title} subtitle={t.companyFiles.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      {expiringFiles.length > 0 && (
        <div style={{ padding: '12px', backgroundColor: '#ffe6e6', borderLeft: '4px solid #e74c3c', marginBottom: '16px', borderRadius: '4px' }}>
          <strong>{t.companyFiles.expiryAlert(expiringFiles.length)}</strong>
        </div>
      )}

      <div className="section-title-row">
        <span className="muted">{t.companyFiles.count(files.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.companyFiles.newItem}
        </button>
      </div>

      {expiringFiles.length > 0 && (
        <>
          <h3 style={{ marginTop: 20, marginBottom: 12 }}>{t.companyFiles.expiringSectionTitle}</h3>
          <div className="card">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t.companyFiles.docTitle}</th>
                    <th>{t.companyFiles.category}</th>
                    <th>{t.companyFiles.issueDate}</th>
                    <th>{t.companyFiles.expiryDate}</th>
                    <th>{t.companyFiles.daysLeft}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {expiringFiles.map((f) => (
                    <tr key={f.id}>
                      <td style={{ fontWeight: 700 }}>{f.title}</td>
                      <td>{CATEGORY_LABELS[f.category]}</td>
                      <td>{f.issue_date ? new Date(f.issue_date).toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB') : '—'}</td>
                      <td>{f.expiry_date ? new Date(f.expiry_date).toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB') : '—'}</td>
                      <td style={{ color: getStatusColor(getExpiryStatus(f)), fontWeight: 700 }}>
                        {f.days_until_expiry !== null ? f.days_until_expiry : '—'}
                      </td>
                      <td>
                        <button className="btn btn-sm" onClick={() => handleDownload(f)}>{t.companyFiles.download}</button>{' '}
                        <button className="btn btn-sm" onClick={() => openEdit(f)}>{t.companyFiles.edit}</button>{' '}
                        <button className="icon-btn" onClick={() => handleDelete(f.id)}>🗑</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <h3 style={{ marginTop: 20, marginBottom: 12 }}>{t.companyFiles.otherSectionTitle}</h3>
      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.companyFiles.docTitle}</th>
                <th>{t.companyFiles.category}</th>
                <th>{t.companyFiles.issueDate}</th>
                <th>{t.companyFiles.expiryDate}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {otherFiles.map((f) => (
                <tr key={f.id}>
                  <td style={{ fontWeight: 700 }}>{f.title}</td>
                  <td>{CATEGORY_LABELS[f.category]}</td>
                  <td>{f.issue_date ? new Date(f.issue_date).toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB') : '—'}</td>
                  <td>{f.expiry_date ? new Date(f.expiry_date).toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB') : t.companyFiles.noDate}</td>
                  <td>
                    <button className="btn btn-sm" onClick={() => handleDownload(f)}>{t.companyFiles.download}</button>{' '}
                    <button className="btn btn-sm" onClick={() => openEdit(f)}>{t.companyFiles.edit}</button>{' '}
                    <button className="icon-btn" onClick={() => handleDelete(f.id)}>🗑</button>
                  </td>
                </tr>
              ))}
              {otherFiles.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">{t.companyFiles.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={editingId ? t.companyFiles.editItem : t.companyFiles.newItem}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="company-file-form" disabled={loading}>
                {loading ? t.common.loading : t.companyFiles.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.companyFiles.cancel}
              </button>
            </>
          )}
        >
          <form id="company-file-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.companyFiles.docTitle}</label>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required autoFocus />
            </div>
            <div className="field">
              <label>{t.companyFiles.category}</label>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as Category })}>
                {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>{t.companyFiles.issueDate}</label>
              <input type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} />
            </div>
            <div className="field">
              <label>{t.companyFiles.expiryDateOptional}</label>
              <input type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} />
            </div>

            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.companyFiles.file} {editingId && form.fileName ? t.companyFiles.currentFile(form.fileName) : ''}</label>
              <input type="file" onChange={(e) => handleFileChange(e.target.files?.[0])} />
            </div>

            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.companyFiles.notes}</label>
              <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
