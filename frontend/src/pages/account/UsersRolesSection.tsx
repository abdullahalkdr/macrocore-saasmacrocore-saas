import { useEffect, useState } from 'react';
import { get, ApiError } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { useT } from '../../i18n';

interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  role: string;
  status: string;
}

export default function UsersRolesSection() {
  const t = useT();
  const authUser = useAuthStore((s) => s.user);
  const [tab, setTab] = useState<'users' | 'roles'>('users');
  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<{ users: UserRow[] }>('/users')
      .then((r) => setUsers(r.users))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.account.loadFailed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const roleCards = [
    { role: 'admin', title: t.account.users.roleAdmin, desc: t.account.users.roleAdminDesc, access: t.account.users.fullAccess },
    { role: 'manager', title: t.account.users.roleManager, desc: t.account.users.roleManagerDesc, access: t.account.users.fullAccess },
    { role: 'employee', title: t.account.users.roleEmployee, desc: t.account.users.roleEmployeeDesc, access: t.account.users.limitedAccess },
    { role: 'viewer', title: t.account.users.roleViewer, desc: t.account.users.roleViewerDesc, access: t.account.users.limitedAccess },
  ];

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <button className={`btn btn-sm ${tab === 'users' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('users')}>
          {t.account.users.tabUsers}
        </button>
        <button className={`btn btn-sm ${tab === 'roles' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('roles')}>
          {t.account.users.tabRoles}
        </button>
      </div>

      {tab === 'users' && (
        <div className="card">
          <div className="card-body" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t.account.users.email}</th>
                  <th>{t.account.users.role}</th>
                  <th>{t.account.users.status}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.full_name || u.email} {u.id === authUser?.id && <span className="badge trial">{t.account.users.you}</span>}
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{u.email}</div>
                    </td>
                    <td>{u.role}</td>
                    <td>
                      <span className={`badge ${u.status === 'active' ? 'open' : 'closed'}`}>{u.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'roles' && (
        <div className="field-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {roleCards.map((r) => (
            <div className="card" key={r.role}>
              <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ fontSize: 15 }}>{r.title}</h2>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {t.account.users.usersCount(users.filter((u) => u.role === r.role).length)}
                </span>
              </div>
              <div className="card-body">
                <p style={{ fontSize: 13, color: 'var(--stone-700)', marginTop: 0 }}>{r.desc}</p>
                <span className={`badge ${r.access === t.account.users.fullAccess ? 'open' : 'closed'}`}>{r.access}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
