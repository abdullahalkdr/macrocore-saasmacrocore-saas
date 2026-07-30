import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Avatar from '../components/Avatar';
import { IconPlus, IconTrash } from '../components/Icon';

interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  status: string;
}

const ROLES = ['admin', 'manager', 'employee', 'viewer'];
const STATUSES = ['active', 'suspended', 'inactive'];

export default function UsersPage() {
  const currentUser = useAuthStore((s) => s.user);
  const t = useT();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('employee');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    get<{ users: UserRow[] }>('/users')
      .then((r) => setUsers(r.users))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.users.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

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
                  <td>
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
                  <td colSpan={6}>
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
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="user-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                {t.common.cancel}
              </button>
            </>
          }
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
    </div>
  );
}
