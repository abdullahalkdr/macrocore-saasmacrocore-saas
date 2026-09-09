import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { useLangStore } from '../store/langStore';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Avatar from '../components/Avatar';
import { IconPlus, IconTrash } from '../components/Icon';
import { canModifyUserRow, assignableRoleOptions, type UserRole } from '../utils/userRoleGuards';

const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => PASSWORD_CHARS[b % PASSWORD_CHARS.length]).join('');
}

interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  status: string;
  employee_id: string | null;
  department_name: string | null;
  department_name_en: string | null;
}

interface EmployeeOption {
  id: string;
  name: string;
}

// Mirrors utils/invitations.ts's derived status (never stored — see that
// file's comment) — Pending/Expired/Accepted/Revoked, decision 8.
interface InvitationRow {
  id: string;
  email: string;
  role: string;
  full_name: string | null;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invited_by_name: string | null;
  created_at: string;
}

const ROLES = ['admin', 'manager', 'employee', 'viewer'];
const STATUSES = ['active', 'suspended', 'inactive'];

export default function UsersPage() {
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = currentUser?.role === 'admin';
  const lang = useLangStore((s) => s.lang);
  const t = useT();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  // Decision 5: managers may only invite into employee/viewer — the server
  // is the real gate (assertInvitableRole in invitations.controller.ts), this
  // just keeps a manager from picking a role they'd be refused anyway. Also
  // reused below as the assignable-role list for EXISTING users, since the
  // same admin/manager role boundary applies there too (users.controller.ts's
  // update()).
  const invitableRoles: UserRole[] = isAdmin ? (ROLES as UserRole[]) : ['employee', 'viewer'];
  // Manager privilege-escalation close (production review, 2026-09-09):
  // matches backend users.controller.ts's update() guard exactly — a manager
  // (never an admin) can't touch any field on an existing admin/manager
  // account. Admins are unrestricted here. Pulled out to utils/userRoleGuards
  // so the exact boundary is unit-tested independent of this component.
  const canModifyRow = (u: UserRow) => canModifyUserRow(currentUser?.role ?? '', u.role);
  const roleOptionsFor = (u: UserRow) => assignableRoleOptions(currentUser?.role ?? '', u.role, ROLES as UserRole[], invitableRoles);
  const [role, setRole] = useState('employee');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editEmployeeId, setEditEmployeeId] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeOption[]>([]);

  const [resetUser, setResetUser] = useState<UserRow | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetLoading, setResetLoading] = useState(false);

  function load() {
    get<{ users: UserRow[] }>('/users')
      .then((r) => setUsers(r.users))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.users.loadFailed));
  }

  function loadInvitations() {
    get<{ invitations: InvitationRow[] }>('/invitations')
      .then((r) => setInvitations(r.invitations))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.users.invitationsLoadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(loadInvitations, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    get<{ employees: EmployeeOption[] }>('/employees').then((r) => setEmployeeOptions(r.employees)).catch(() => {});
  }, []);

  // Decision 7: never create an account directly with a temp password here
  // again — this now sends an invitation (POST /api/invitations), same flow
  // and same email templates as the signup colleague-invite path (decision 1).
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await post<{ success: boolean; email_queued: boolean }>('/invitations', {
        email,
        full_name: name || undefined,
        role,
        preferred_language: lang,
      });
      setNotice(res.email_queued ? t.users.inviteSentNotice(email) : t.users.inviteSentEmailFailedNotice(email));
      setEmail('');
      setName('');
      setRole('employee');
      setOpen(false);
      loadInvitations();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.users.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function resendInvitation(id: string) {
    setError(null);
    setNotice(null);
    try {
      const res = await post<{ success: boolean; email_queued: boolean }>(`/invitations/${id}/resend`);
      setNotice(res.email_queued ? t.users.resendSuccess : t.users.resendEmailFailedNotice);
      loadInvitations();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.users.resendFailed);
    }
  }

  async function revokeInvitation(id: string) {
    if (!confirm(t.users.revokeConfirm)) return;
    setError(null);
    setNotice(null);
    try {
      await post(`/invitations/${id}/revoke`);
      setNotice(t.users.revokeSuccess);
      loadInvitations();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.users.revokeFailed);
    }
  }

  async function updateRole(id: string, newRole: string) {
    try {
      await patch(`/users/${id}`, { role: newRole });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.users.roleFailed);
    }
  }

  async function updateStatus(id: string, newStatus: string) {
    try {
      await patch(`/users/${id}`, { status: newStatus });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.users.statusFailed);
    }
  }

  async function removeUser(id: string) {
    if (!confirm(t.users.confirmDelete)) return;
    try {
      await del(`/users/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.users.deleteFailed);
    }
  }

  function openEdit(u: UserRow) {
    setEditUser(u);
    setEditName(u.full_name || '');
    setEditEmail(u.email);
    setEditEmployeeId(u.employee_id || '');
  }

  async function handleEditSubmit(e: FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    setError(null);
    setEditLoading(true);
    try {
      await patch(`/users/${editUser.id}`, { full_name: editName, email: editEmail, employee_id: editEmployeeId || null });
      setEditUser(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.users.editSaveFailed);
    } finally {
      setEditLoading(false);
    }
  }

  function openReset(u: UserRow) {
    setResetUser(u);
    setNewPassword('');
  }

  async function handleResetSubmit(e: FormEvent) {
    e.preventDefault();
    if (!resetUser) return;
    setError(null);
    setNotice(null);
    setResetLoading(true);
    try {
      await patch(`/users/${resetUser.id}`, { new_password: newPassword });
      setNotice(t.users.resetSuccessNotice(resetUser.email, newPassword));
      setResetUser(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.users.resetFailed);
    } finally {
      setResetLoading(false);
    }
  }

  return (
    <div>
      <PageHeader title={t.users.title} subtitle={t.users.subtitle} />
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      <div className="section-title-row">
        <span className="muted">{t.users.count(users.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          <IconPlus /> {t.users.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th></th>
                <th>{t.users.name}</th>
                <th>{t.users.email}</th>
                <th>{t.users.department}</th>
                <th>{t.users.role}</th>
                <th>{t.users.status}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Avatar name={u.full_name || u.email} />
                  </td>
                  <td style={{ fontWeight: 700 }}>{u.full_name || '—'}</td>
                  <td>{u.email}</td>
                  <td className="muted">{u.department_name || t.users.noDepartment}</td>
                  <td>
                    <select
                      value={u.role}
                      onChange={(e) => updateRole(u.id, e.target.value)}
                      disabled={u.id === currentUser?.id || !canModifyRow(u)}
                      title={!canModifyRow(u) ? t.users.managerCannotModify : undefined}
                    >
                      {roleOptionsFor(u).map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      value={u.status}
                      onChange={(e) => updateStatus(u.id, e.target.value)}
                      disabled={u.id === currentUser?.id || !canModifyRow(u)}
                      title={!canModifyRow(u) ? t.users.managerCannotModify : undefined}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="icon-btn"
                      onClick={() => openEdit(u)}
                      title={!canModifyRow(u) ? t.users.managerCannotModify : t.users.editItem}
                      disabled={!canModifyRow(u)}
                    >
                      ✎
                    </button>
                    {isAdmin && u.id !== currentUser?.id && (
                      <button className="icon-btn" onClick={() => openReset(u)} title={t.users.resetPassword}>🔑</button>
                    )}
                    {u.id !== currentUser?.id && (
                      <button className="icon-btn" onClick={() => removeUser(u.id)} title={t.common.delete}>
                        <IconTrash />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">{t.users.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section-title-row" style={{ marginTop: 24 }}>
        <span className="muted">{t.users.pendingInvitationsTitle}</span>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.users.email}</th>
                <th>{t.users.name}</th>
                <th>{t.users.role}</th>
                <th>{t.users.status}</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.id}>
                  <td>{inv.email}</td>
                  <td>{inv.full_name || '—'}</td>
                  <td>{inv.role}</td>
                  <td>
                    <span className={`badge ${inv.status}`}>
                      {inv.status === 'pending' && t.users.statusPending}
                      {inv.status === 'expired' && t.users.statusExpired}
                      {inv.status === 'accepted' && t.users.statusAccepted}
                      {inv.status === 'revoked' && t.users.statusRevoked}
                    </span>
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>{inv.invited_by_name ? t.users.invitedBy(inv.invited_by_name) : ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {inv.status !== 'accepted' && (
                      <button className="btn btn-secondary btn-sm" onClick={() => resendInvitation(inv.id)}>
                        {t.users.resendInvite}
                      </button>
                    )}
                    {inv.status === 'pending' && (
                      <button className="btn btn-secondary btn-sm" style={{ marginInlineStart: 6, color: 'var(--danger)' }} onClick={() => revokeInvitation(inv.id)}>
                        {t.users.revokeInvite}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {invitations.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">{t.users.pendingInvitationsEmpty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={t.users.newItem}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="user-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="user-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.users.email}</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label>{t.users.inviteNameOptional}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.users.role}</label>
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {invitableRoles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </form>
          <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
            {t.users.inviteNameHint}
          </p>
        </Modal>
      )}

      {editUser && (
        <Modal
          title={t.users.editItem}
          onClose={() => setEditUser(null)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="edit-user-form" disabled={editLoading}>
                {editLoading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="edit-user-form" onSubmit={handleEditSubmit} className="field-grid">
            <div className="field">
              <label>{t.users.name}</label>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label>{t.users.email}</label>
              <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} required />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.users.linkedEmployee}</label>
              <select value={editEmployeeId} onChange={(e) => setEditEmployeeId(e.target.value)}>
                <option value="">{t.users.linkedEmployeeNone}</option>
                {employeeOptions.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{t.users.linkedEmployeeHint}</div>
            </div>
          </form>
        </Modal>
      )}

      {resetUser && (
        <Modal
          title={t.users.resetPasswordTitle(resetUser.email)}
          onClose={() => setResetUser(null)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="reset-password-form" disabled={resetLoading || newPassword.length < 6}>
                {resetLoading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="reset-password-form" onSubmit={handleResetSubmit} className="field-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.users.newPassword}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={6}
                  autoFocus
                  style={{ flex: 1 }}
                />
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setNewPassword(randomPassword())}>
                  {t.users.generate}
                </button>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{t.users.minLengthHint}</div>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
