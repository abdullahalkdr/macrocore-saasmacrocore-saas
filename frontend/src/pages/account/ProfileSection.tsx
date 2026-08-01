import { FormEvent, useEffect, useState } from 'react';
import { get, patch, post, ApiError } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { useT } from '../../i18n';

interface MeResponse {
  user: {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    job_title: string | null;
    phone: string | null;
    role: string;
  };
}

export default function ProfileSection() {
  const t = useT();
  const authUser = useAuthStore((s) => s.user);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [changingPw, setChangingPw] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState<string | null>(null);

  useEffect(() => {
    get<MeResponse>('/users/me')
      .then((r) => {
        setFirstName(r.user.first_name || '');
        setLastName(r.user.last_name || '');
        setPhone(r.user.phone || '');
        setJobTitle(r.user.job_title || '');
        setEmail(r.user.email);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t.account.loadFailed))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      await patch('/users/me', { first_name: firstName, last_name: lastName, job_title: jobTitle });
      setSuccess(t.account.saved);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.account.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  async function handleSavePhone() {
    setError(null);
    setPhoneSaving(true);
    try {
      await patch('/users/me', { phone });
      setEditingPhone(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.account.saveFailed);
    } finally {
      setPhoneSaving(false);
    }
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwSuccess(null);
    try {
      await post('/auth/change-password', { current_password: currentPw, new_password: newPw });
      setPwSuccess(t.account.saved);
      setCurrentPw('');
      setNewPw('');
      setChangingPw(false);
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : t.account.saveFailed);
    }
  }

  if (loading) return <div className="muted">{t.common.loading}</div>;

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {success && <div className="success-banner">{success}</div>}

      <form onSubmit={handleSave}>
        <div className="card">
          <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>{t.account.profile.personalInfo}</h2>
            {!editing && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
                {t.account.profile.edit}
              </button>
            )}
          </div>
          <div className="card-body">
            <div className="field-grid">
              <div className="field">
                <label>{t.account.profile.firstName}</label>
                <input value={firstName} onChange={(e) => setFirstName(e.target.value)} disabled={!editing} />
              </div>
              <div className="field">
                <label>{t.account.profile.lastName}</label>
                <input value={lastName} onChange={(e) => setLastName(e.target.value)} disabled={!editing} />
              </div>
              <div className="field">
                <label>{t.account.profile.jobTitle}</label>
                <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} disabled={!editing} />
              </div>
            </div>
            {editing && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>
                  {saving ? t.common.loading : t.account.profile.save}
                </button>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => setEditing(false)}>
                  {t.account.profile.cancel}
                </button>
              </div>
            )}
          </div>
        </div>
      </form>

      <div className="card">
        <div className="card-head">
          <h2>{t.account.profile.loginSecurity}</h2>
        </div>
        <div className="card-body">
          <div className="field-grid">
            <div className="field">
              <label>{t.account.profile.email}</label>
              <input value={email} disabled />
            </div>
            <div className="field">
              <label>{t.account.profile.phone}</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setEditingPhone(true);
                  }}
                  placeholder="+965 5xxxxxxx"
                />
                {editingPhone && (
                  <button className="btn btn-primary btn-sm" type="button" onClick={handleSavePhone} disabled={phoneSaving}>
                    {phoneSaving ? t.common.loading : t.account.profile.save}
                  </button>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{t.account.profile.phoneHint}</div>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            {!changingPw ? (
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setChangingPw(true)}>
                {t.account.profile.changePassword}
              </button>
            ) : (
              <form onSubmit={handleChangePassword} style={{ maxWidth: 340 }}>
                {pwError && <div className="error-banner">{pwError}</div>}
                {pwSuccess && <div className="success-banner">{pwSuccess}</div>}
                <div className="field">
                  <label>{t.account.profile.currentPassword}</label>
                  <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} required />
                </div>
                <div className="field">
                  <label>{t.account.profile.newPassword}</label>
                  <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} required />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary btn-sm" type="submit">
                    {t.account.profile.save}
                  </button>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => setChangingPw(false)}>
                    {t.account.profile.cancel}
                  </button>
                </div>
              </form>
            )}
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
            {t.account.profile.jobTitle}: {authUser?.role}
          </div>
        </div>
      </div>
    </div>
  );
}
