import { FormEvent, useEffect, useState } from 'react';
import { get, patch, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';

export default function SalesSettingsPage() {
  const t = useT();
  const [notes, setNotes] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    get<{ default_sales_notes: string | null }>('/company/me')
      .then((r) => {
        setNotes(r.default_sales_notes || '');
        setLoaded(true);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t.account.loadFailed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      await patch('/company/me', { default_sales_notes: notes });
      setSuccess(t.account.saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.account.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader title={t.salesDocs.salesSettingsTitle} subtitle={t.salesDocs.salesSettingsSubtitle} />
      {error && <div className="error-banner">{error}</div>}
      {success && <div className="success-banner">{success}</div>}

      <form onSubmit={handleSave}>
        <div className="card">
          <div className="card-head">
            <h2>{t.salesSettings.defaultNotesTitle}</h2>
          </div>
          <div className="card-body">
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              {t.salesSettings.defaultNotesHint}
            </p>
            <div className="field">
              <label>{t.salesSettings.defaultNotesLabel}</label>
              <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!loaded} />
            </div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={saving || !loaded}>
              {saving ? t.common.loading : t.common.save}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
