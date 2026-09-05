import { FormEvent, useEffect, useState } from 'react';
import { get, patch, post, ApiError } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { useT } from '../../i18n';
import { useLangStore } from '../../store/langStore';
import { usePolicyStore, PendingPermissionGrant } from '../../store/usePolicyStore';
import { usePermissionsStore } from '../../store/usePermissionsStore';
import PermissionGrantAcknowledgeModal from '../../components/PermissionGrantAcknowledgeModal';

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
  const lang = useLangStore((s) => s.lang);
  const authUser = useAuthStore((s) => s.user);
  const pendingGrants = usePolicyStore((s) => s.pendingGrants);
  const pendingGrantsLoading = usePolicyStore((s) => s.pendingGrantsLoading);
  const fetchPendingGrants = usePolicyStore((s) => s.fetchPendingGrants);
  const fetchMyPermissions = usePermissionsStore((s) => s.fetchMyPermissions);
  const [openGrant, setOpenGrant] = useState<PendingPermissionGrant | null>(null);
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

  // Policy Gate pilot (MIGRATION_074/075) — Step 3. Fetch this employee's own pending
  // grants once on mount; the notification bell deep-links here (?section=profile)
  // instead of trying to open a specific grant directly, so this is the only place
  // that ever loads them.
  useEffect(() => {
    fetchPendingGrants();
  }, [fetchPendingGrants]);

  // Closing the modal — whether by acknowledging or by dismissing without acknowledging
  // — always refetches: acknowledging removes this grant from the pending list and
  // activates the permission (fetchMyPermissions refreshes Layout's own copy so the
  // sidebar reflects it immediately); dismissing leaves the grant exactly as it was, so
  // the refetch is a no-op there, but it's cheap and keeps this one code path for both.
  function closeGrantModal() {
    setOpenGrant(null);
    fetchPendingGrants();
    fetchMyPermissions();
  }

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

  // BUGFIX — the login/security card used to reuse t.account.profile.jobTitle's label
  // ("Role"/"الدور") to show the actual system role, while that exact same label sat
  // on the free-text job-title field above it — one wrong translation, shown twice,
  // meaning two different things. Now the system role gets its own `role` key, and
  // the raw enum value (admin/manager/employee/viewer) is translated the same way
  // UsersRolesSection.tsx already does, instead of printing it verbatim.
  const roleLabels: Record<string, string> = {
    admin: t.account.users.roleAdmin,
    manager: t.account.users.roleManager,
    employee: t.account.users.roleEmployee,
    viewer: t.account.users.roleViewer,
  };

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
            {t.account.profile.role}: {(authUser?.role && roleLabels[authUser.role]) || authUser?.role}
          </div>
        </div>
      </div>

      {/* Policy Gate pilot (MIGRATION_074/075) — Step 3. Permanent section, not just a
          one-time notification target: an employee may dismiss the notification and/or
          close the acknowledgment modal without acknowledging, then come back later —
          this card is where they come back to. Deliberately separate from the general
          P&P mandatory-acknowledgment queue (AcknowledgmentModal/usePolicyStore.pending)
          — that one still blocks at login as before; this pilot never blocks anything,
          it only gates one already-enforced permission per grant. */}
      <div className="card">
        <div className="card-head">
          <h2>{t.account.policyGrants.title}</h2>
        </div>
        <div className="card-body">
          <div className="muted" style={{ marginBottom: 12 }}>{t.account.policyGrants.subtitle}</div>
          {/* BUGFIX (2026-09) — render off pendingGrantsLoading, not just
              pendingGrants.length: fetchPendingGrants now clears pendingGrants to []
              the instant it starts (see usePolicyStore.ts), specifically so a
              previous user's policy content can never linger on screen across a
              logout/login in the same tab. Without this loading check, that
              synchronous [] would flash the empty-state message every time this
              section mounts, even when the real fetch is about to come back
              non-empty. */}
          {pendingGrantsLoading ? (
            <div className="muted">{t.common.loading}</div>
          ) : pendingGrants.length === 0 ? (
            <div className="empty-state">{t.account.policyGrants.empty}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pendingGrants.map((g) => {
                const displayName = (lang === 'en' && g.name_en) || g.name;
                const permLabel = (t.permissions.keys as Record<string, string>)[g.permission_key] ?? g.permission_key;
                return (
                  <div
                    key={g.id}
                    className="invite-row"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
                  >
                    <div>
                      <div style={{ fontWeight: 700 }}>{displayName}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{t.account.policyGrants.activates(permLabel)}</div>
                    </div>
                    <button className="btn btn-primary btn-sm" type="button" onClick={() => setOpenGrant(g)}>
                      {t.account.policyGrants.viewButton}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {openGrant && <PermissionGrantAcknowledgeModal grant={openGrant} onClose={closeGrantModal} />}
    </div>
  );
}
