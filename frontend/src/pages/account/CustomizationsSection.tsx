import { FormEvent, useEffect, useState } from 'react';
import { get, post, put, del, ApiError } from '../../api/client';
import { useT } from '../../i18n';

interface Template {
  id: string;
  name: string;
  primary_color: string;
  footer_text: string | null;
  show_stamp: boolean;
}

interface CustomField {
  id: string;
  name: string;
  field_type: string;
  applies_to: string;
  created_at: string;
}

export default function CustomizationsSection() {
  const t = useT();
  const [template, setTemplate] = useState<Template | null>(null);
  const [color, setColor] = useState('#f59e0b');
  const [footerText, setFooterText] = useState('');
  const [showStamp, setShowStamp] = useState(false);
  const [fields, setFields] = useState<CustomField[]>([]);
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldType, setNewFieldType] = useState('text');
  const [newFieldAppliesTo, setNewFieldAppliesTo] = useState('official_documents');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function loadTemplate() {
    get<{ template: Template | null }>('/document-templates/default')
      .then((r) => {
        if (r.template) {
          setTemplate(r.template);
          setColor(r.template.primary_color);
          setFooterText(r.template.footer_text || '');
          setShowStamp(r.template.show_stamp);
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t.account.loadFailed));
  }

  function loadFields() {
    get<{ custom_fields: CustomField[] }>('/custom-fields')
      .then((r) => setFields(r.custom_fields))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.account.loadFailed));
  }

  useEffect(() => {
    loadTemplate();
    loadFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSaveTemplate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    try {
      await put('/document-templates/default', { primary_color: color, footer_text: footerText, show_stamp: showStamp });
      setSuccess(t.account.saved);
      loadTemplate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.account.saveFailed);
    }
  }

  async function handleAddField(e: FormEvent) {
    e.preventDefault();
    if (!newFieldName.trim()) return;
    try {
      await post('/custom-fields', { name: newFieldName, field_type: newFieldType, applies_to: newFieldAppliesTo });
      setNewFieldName('');
      loadFields();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.account.saveFailed);
    }
  }

  async function handleDeleteField(id: string) {
    try {
      await del(`/custom-fields/${id}`);
      loadFields();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.account.saveFailed);
    }
  }

  const appliesLabel: Record<string, string> = {
    official_documents: t.account.customizations.appliesOfficialDocs,
    company_files: t.account.customizations.appliesCompanyFiles,
    employees: t.account.customizations.appliesEmployees,
  };
  const typeLabel: Record<string, string> = {
    text: t.account.customizations.fieldTypeText,
    number: t.account.customizations.fieldTypeNumber,
    date: t.account.customizations.fieldTypeDate,
    yes_no: t.account.customizations.fieldTypeYesNo,
  };

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {success && <div className="success-banner">{success}</div>}

      <form onSubmit={handleSaveTemplate}>
        <div className="card">
          <div className="card-head">
            <h2>{t.account.sections.templatesTitle}</h2>
          </div>
          <div className="card-body">
            <div className="field-grid">
              <div className="field">
                <label>{t.account.customizations.primaryColor}</label>
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ height: 38 }} />
              </div>
              <div className="field" style={{ gridColumn: 'span 2' }}>
                <label>{t.account.customizations.footerText}</label>
                <input value={footerText} onChange={(e) => setFooterText(e.target.value)} />
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 10 }}>
              <input type="checkbox" checked={showStamp} onChange={(e) => setShowStamp(e.target.checked)} />
              {t.account.customizations.showStamp}
            </label>
            <button className="btn btn-primary btn-sm" type="submit" style={{ marginTop: 12 }}>
              {t.account.profile.save}
            </button>
          </div>
        </div>
      </form>

      <div className="card">
        <div className="card-head">
          <h2>{t.account.sections.customFieldsTitle}</h2>
        </div>
        <div className="card-body">
          <form onSubmit={handleAddField} className="form-row" style={{ marginBottom: 14 }}>
            <div className="field" style={{ flex: 2 }}>
              <input placeholder={t.account.customizations.fieldName} value={newFieldName} onChange={(e) => setNewFieldName(e.target.value)} />
            </div>
            <div className="field">
              <select value={newFieldType} onChange={(e) => setNewFieldType(e.target.value)}>
                <option value="text">{t.account.customizations.fieldTypeText}</option>
                <option value="number">{t.account.customizations.fieldTypeNumber}</option>
                <option value="date">{t.account.customizations.fieldTypeDate}</option>
                <option value="yes_no">{t.account.customizations.fieldTypeYesNo}</option>
              </select>
            </div>
            <div className="field">
              <select value={newFieldAppliesTo} onChange={(e) => setNewFieldAppliesTo(e.target.value)}>
                <option value="official_documents">{t.account.customizations.appliesOfficialDocs}</option>
                <option value="company_files">{t.account.customizations.appliesCompanyFiles}</option>
                <option value="employees">{t.account.customizations.appliesEmployees}</option>
              </select>
            </div>
            <button className="btn btn-primary btn-sm" type="submit">
              {t.account.customizations.addField}
            </button>
          </form>

          {fields.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>
              {t.account.customizations.empty}
            </p>
          ) : (
            fields.map((f) => (
              <div key={f.id} className="invite-row">
                <span>
                  <strong>{f.name}</strong> — {typeLabel[f.field_type] || f.field_type} · {appliesLabel[f.applies_to] || f.applies_to}
                </span>
                <button className="icon-btn" onClick={() => handleDeleteField(f.id)}>
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
