import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { IconPlus } from '../components/Icon';

type DocType = 'letter' | 'salary_certificate' | 'experience_certificate' | 'receipt' | 'other';

interface Employee {
  id: string;
  name: string;
}

interface Doc {
  id: string;
  reference_number: string;
  doc_type: DocType;
  title: string;
  addressed_to_employee_id: string | null;
  addressed_to_name: string | null;
  addressed_to_employee_name: string | null;
  document_date: string;
  body: string | null;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

const EXTERNAL_OPTION = '__external__';

export default function OfficialDocumentsPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const DOC_TYPE_LABELS: Record<DocType, string> = {
    letter: t.officialDocuments.docTypeLetter,
    salary_certificate: t.officialDocuments.docTypeSalaryCert,
    experience_certificate: t.officialDocuments.docTypeExperienceCert,
    receipt: t.officialDocuments.docTypeReceipt,
    other: t.officialDocuments.docTypeOther,
  };
  function fmtDate(d: string) {
    return new Date(d).toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB');
  }
  const [docs, setDocs] = useState<Doc[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [docType, setDocType] = useState<DocType>('letter');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [addressedToChoice, setAddressedToChoice] = useState(''); // employee id, or EXTERNAL_OPTION, or ''
  const [addressedToName, setAddressedToName] = useState('');
  const [title, setTitle] = useState('');
  const [documentDate, setDocumentDate] = useState(todayStr());
  const [body, setBody] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    get<{ documents: Doc[] }>('/official-documents')
      .then((r) => setDocs(r.documents))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.officialDocuments.loadFailed));
  }

  useEffect(() => {
    load();
    get<{ employees: Employee[] }>('/employees').then((r) => setEmployees(r.employees)).catch(() => {});
  }, []);

  function resetForm() {
    setDocType('letter');
    setReferenceNumber('');
    setAddressedToChoice('');
    setAddressedToName('');
    setTitle('');
    setDocumentDate(todayStr());
    setBody('');
    setEditingId(null);
  }

  async function openCreate() {
    resetForm();
    setOpen(true);
    try {
      const r = await get<{ reference_number: string }>('/official-documents/next-reference');
      setReferenceNumber(r.reference_number);
    } catch {
      // non-fatal — backend assigns the real one at save time regardless
    }
  }

  function openEdit(d: Doc) {
    setEditingId(d.id);
    setDocType(d.doc_type);
    setReferenceNumber(d.reference_number);
    setAddressedToChoice(d.addressed_to_employee_id || (d.addressed_to_name ? EXTERNAL_OPTION : ''));
    setAddressedToName(d.addressed_to_name || '');
    setTitle(d.title);
    setDocumentDate(d.document_date.slice(0, 10));
    setBody(d.body || '');
    setOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const isExternal = addressedToChoice === EXTERNAL_OPTION;
      const payload = {
        doc_type: docType,
        title,
        addressed_to_employee_id: isExternal ? undefined : addressedToChoice || undefined,
        addressed_to_name: isExternal ? addressedToName : undefined,
        document_date: documentDate,
        body: body || undefined,
      };
      if (editingId) {
        await patch(`/official-documents/${editingId}`, payload);
      } else {
        await post('/official-documents', payload);
      }
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.officialDocuments.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.officialDocuments.deleteConfirm)) return;
    try {
      await del(`/official-documents/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.officialDocuments.deleteFailed);
    }
  }

  function addresseeLabel(d: Doc) {
    return d.addressed_to_employee_name || d.addressed_to_name || '—';
  }

  function handlePrint() {
    const win = window.open('', '_blank');
    if (!win) return;
    const isExternal = addressedToChoice === EXTERNAL_OPTION;
    const addressee = isExternal ? addressedToName : employees.find((e) => e.id === addressedToChoice)?.name || '';
    win.document.write(`
      <!DOCTYPE html>
      <html dir="rtl" lang="ar">
      <head>
        <meta charset="utf-8" />
        <title>${referenceNumber || t.officialDocuments.printedTitle}</title>
        <style>
          body { font-family: 'Tajawal', Arial, sans-serif; padding: 40px; color: #1c1917; }
          .header { display: flex; justify-content: space-between; border-bottom: 2px solid #F5A623; padding-bottom: 12px; margin-bottom: 24px; }
          .ref { color: #78716c; font-size: 13px; }
          h1 { font-size: 20px; margin: 0 0 4px; }
          .meta { color: #57534e; font-size: 13px; margin-bottom: 20px; }
          .body { white-space: pre-wrap; line-height: 1.9; font-size: 15px; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <h1>${title || ''}</h1>
            <div class="meta">${DOC_TYPE_LABELS[docType]}${addressee ? ` — ${t.officialDocuments.toLabel}: ${addressee}` : ''}</div>
          </div>
          <div class="ref">
            <div>${referenceNumber}</div>
            <div>${fmtDate(documentDate)}</div>
          </div>
        </div>
        <div class="body">${(body || '').replace(/</g, '&lt;')}</div>
      </body>
      </html>
    `);
    win.document.close();
    win.focus();
    win.print();
  }

  return (
    <div>
      <PageHeader title={t.officialDocuments.title} subtitle={t.officialDocuments.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.officialDocuments.newItem}
        </button>
        <span className="muted">{t.officialDocuments.count(docs.length)}</span>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.officialDocuments.refNumber}</th>
                <th>{t.officialDocuments.type}</th>
                <th>{t.officialDocuments.docTitle}</th>
                <th>{t.officialDocuments.addressee}</th>
                <th>{t.officialDocuments.date}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td style={{ fontWeight: 700 }}>{d.reference_number}</td>
                  <td>
                    <span
                      style={{
                        padding: '2px 10px',
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 700,
                        backgroundColor: '#fff4e5',
                        color: '#b45309',
                      }}
                    >
                      {DOC_TYPE_LABELS[d.doc_type]}
                    </span>
                  </td>
                  <td>{d.title}</td>
                  <td>{addresseeLabel(d)}</td>
                  <td>{fmtDate(d.document_date)}</td>
                  <td>
                    <button className="icon-btn" onClick={() => handleDelete(d.id)} title={t.officialDocuments.delete}>🗑</button>
                    <button className="icon-btn" onClick={() => openEdit(d)} title={t.officialDocuments.edit}>✎</button>
                  </td>
                </tr>
              ))}
              {docs.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">{t.officialDocuments.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={t.officialDocuments.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="doc-form" disabled={loading}>
                {loading ? t.common.loading : t.officialDocuments.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={handlePrint}>
                {t.officialDocuments.print}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                {t.officialDocuments.cancel}
              </button>
            </>
          }
        >
          <form id="doc-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.officialDocuments.typeLabel}</label>
              <select value={docType} onChange={(e) => setDocType(e.target.value as DocType)}>
                {Object.entries(DOC_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.officialDocuments.refAutoLabel}</label>
              <input value={referenceNumber} disabled placeholder={t.officialDocuments.refAutoPlaceholder} />
            </div>

            <div className="field">
              <label>{t.officialDocuments.addresseeLabel}</label>
              <select value={addressedToChoice} onChange={(e) => setAddressedToChoice(e.target.value)}>
                <option value="">{t.officialDocuments.selectPlaceholder}</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
                <option value={EXTERNAL_OPTION}>{t.officialDocuments.externalOption}</option>
              </select>
            </div>
            <div className="field">
              <label>{t.officialDocuments.titleLabel}</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t.officialDocuments.titlePlaceholder}
                required
              />
            </div>

            {addressedToChoice === EXTERNAL_OPTION && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>{t.officialDocuments.externalNameLabel}</label>
                <input value={addressedToName} onChange={(e) => setAddressedToName(e.target.value)} required />
              </div>
            )}

            <div className="field">
              <label>{t.officialDocuments.dateLabel}</label>
              <input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} required />
            </div>

            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.officialDocuments.bodyLabel}</label>
              <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
