import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Avatar from '../components/Avatar';
import { IconPlus, IconTrash } from '../components/Icon';

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

const ROLES = ['admin', 'manager', 'employee', 'viewer'];
const STATUSES = ['active', 'suspended', 'inactive'];

export default function UsersPage() {
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = currentUser?.role === 'admin';
  const t = useT();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
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

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    get<{ employees: EmployeeOption[] }>('/employees').then((r) => setEmployeeOptions(r.employees)).catch(() => {});
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await post<{ user: UserRow; temp_password: string }>('/users', { email, name, role });
      setNotice(t.users.createdNotice(res.user.email, res.temp_password));
      setEmail('');
      setName('');
      setRole('employee');
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.users.saveFailed);
    } finally {
      setLoading(false);
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
                    <select value={u.role} onChange={(e) => updateRole(u.id, e.target.value)} disabled={u.id === currentUser?.id}>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select value={u.status} onChange={(e) => updateStatus(u.id, e.target.value)} disabled={u.id === currentUser?.id}>
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="icon-btn" onClick={() => openEdit(u)} title={t.users.editItem}>✎</button>
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
              <label>{t.users.name}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label>{t.users.email}</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label>{t.users.role}</label>
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </form>
          <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
            {t.users.tempPasswordHint}
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
