import { useEffect, useState } from 'react';
import { get, put, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';

interface EmployeeRow {
  id: string;
  full_name: string | null;
  email: string;
  permission_keys: string[];
}

// MIGRATION_054 — a job_roles row (across all departments), with its currently-granted
// job_role_permissions.
interface JobRoleRow {
  id: string;
  name: string;
  name_en: string | null;
  department_name: string;
  department_name_en: string | null;
}
interface JobRoleWithGrants extends JobRoleRow {
  permission_keys: string[];
}

// Kept in sync by hand with backend/src/controllers/permissions.controller.ts's own
// PERMISSION_KEYS — the backend is the source of truth (it 400s on an unknown key), this
// list only drives which checkbox columns render.
const PERMISSION_KEYS = [
  'approve_leave',
  'manual_attendance',
  'edit_waste',
  'edit_expenses',
  'manage_payroll',
  'view_profit_margins',
  'view_all_employees',
  'edit_sensitive_data',
  'view_financials',
  'manage_cost_centers',
  'approve_purchase_orders',
  'override_credit_limit',
  'submit_appraisal',
  'apply_custom_discount',
  'export_sensitive_reports',
  'manage_system_settings',
] as const;
type PermissionKey = (typeof PERMISSION_KEYS)[number];

export default function PermissionsPage() {
  const t = useT();
  const [tab, setTab] = useState<'user' | 'jobRole'>('user');

  // --- By-employee tab (existing) ---
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [dirtyUsers, setDirtyUsers] = useState<Record<string, string[]>>({});
  const [savingUserId, setSavingUserId] = useState<string | null>(null);

  // --- By-job-role tab (new) ---
  const [jobRoles, setJobRoles] = useState<JobRoleWithGrants[]>([]);
  const [dirtyRoles, setDirtyRoles] = useState<Record<string, string[]>>({});
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Client-side only — both lists are already scoped to one company (small enough to
  // filter in the browser, no need for a server round-trip per keystroke).
  const [userSearch, setUserSearch] = useState('');
  const [roleSearch, setRoleSearch] = useState('');
  const filteredEmployees = employees.filter((e) =>
    (e.full_name || e.email).toLowerCase().includes(userSearch.trim().toLowerCase())
  );
  const filteredJobRoles = jobRoles.filter((r) =>
    (r.name_en || r.name).toLowerCase().includes(roleSearch.trim().toLowerCase()) || r.name.includes(roleSearch.trim())
  );

  function loadUsers() {
    get<{ employees: EmployeeRow[] }>('/permissions')
      .then((r) => setEmployees(r.employees))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.permissions.loadFailed));
  }
  function loadJobRoles() {
    get<{ job_roles: JobRoleWithGrants[] }>('/permissions/job-roles')
      .then((r) => setJobRoles(r.job_roles))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.permissions.loadFailed));
  }

  useEffect(() => {
    loadUsers();
    loadJobRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function currentUserKeys(emp: EmployeeRow): string[] {
    return dirtyUsers[emp.id] ?? emp.permission_keys;
  }
  function toggleUser(emp: EmployeeRow, key: PermissionKey) {
    const keys = currentUserKeys(emp);
    const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
    setDirtyUsers((d) => ({ ...d, [emp.id]: next }));
  }
  async function saveUser(emp: EmployeeRow) {
    setError(null);
    setNotice(null);
    setSavingUserId(emp.id);
    try {
      await put(`/permissions/${emp.id}`, { permission_keys: currentUserKeys(emp) });
      setNotice(t.permissions.saved);
      loadUsers();
      setDirtyUsers((d) => {
        const next = { ...d };
        delete next[emp.id];
        return next;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.permissions.saveFailed);
    } finally {
      setSavingUserId(null);
    }
  }

  function currentRoleKeys(role: JobRoleWithGrants): string[] {
    return dirtyRoles[role.id] ?? role.permission_keys;
  }
  function toggleRole(role: JobRoleWithGrants, key: PermissionKey) {
    const keys = currentRoleKeys(role);
    const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
    setDirtyRoles((d) => ({ ...d, [role.id]: next }));
  }
  async function saveRole(role: JobRoleWithGrants) {
    setError(null);
    setNotice(null);
    setSavingRoleId(role.id);
    try {
      await put(`/permissions/job-roles/${role.id}`, { permission_keys: currentRoleKeys(role) });
      setNotice(t.permissions.saved);
      loadJobRoles();
      setDirtyRoles((d) => {
        const next = { ...d };
        delete next[role.id];
        return next;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.permissions.saveFailed);
    } finally {
      setSavingRoleId(null);
    }
  }

  return (
    <div>
      <PageHeader title={t.permissions.title} subtitle={tab === 'user' ? t.permissions.subtitle : t.permissions.subtitleJobRole} />
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      <div className="tabs" style={{ marginBottom: 14 }}>
        <button className={`tab-btn${tab === 'user' ? ' active' : ''}`} onClick={() => setTab('user')} type="button">
          {t.permissions.tabByUser}
        </button>
        <button className={`tab-btn${tab === 'jobRole' ? ' active' : ''}`} onClick={() => setTab('jobRole')} type="button">
          {t.permissions.tabByJobRole}
        </button>
      </div>

      {tab === 'user' && (
        <div className="card">
          <div className="field" style={{ maxWidth: 320, marginBottom: 12 }}>
            <input
              type="text"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder={t.permissions.searchEmployee}
            />
          </div>
          <div className="table-wrap permissions-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.permissions.employee}</th>
                  {PERMISSION_KEYS.map((key) => (
                    <th key={key}>{t.permissions.keys[key]}</th>
                  ))}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredEmployees.map((emp) => {
                  const keys = currentUserKeys(emp);
                  const isDirty = emp.id in dirtyUsers;
                  return (
                    <tr key={emp.id}>
                      <td style={{ fontWeight: 700 }}>{emp.full_name || emp.email}</td>
                      {PERMISSION_KEYS.map((key) => (
                        <td key={key} style={{ textAlign: 'center' }}>
                          <input type="checkbox" checked={keys.includes(key)} onChange={() => toggleUser(emp, key)} />
                        </td>
                      ))}
                      <td>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={!isDirty || savingUserId === emp.id}
                          onClick={() => saveUser(emp)}
                        >
                          {savingUserId === emp.id ? t.common.loading : t.common.save}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {filteredEmployees.length === 0 && (
                  <tr>
                    <td colSpan={PERMISSION_KEYS.length + 2}>
                      <div className="empty-state">{employees.length === 0 ? t.permissions.empty : t.permissions.noResults}</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'jobRole' && (
        <div className="card">
          <div className="field" style={{ maxWidth: 320, marginBottom: 12 }}>
            <input
              type="text"
              value={roleSearch}
              onChange={(e) => setRoleSearch(e.target.value)}
              placeholder={t.permissions.searchJobRole}
            />
          </div>
          <div className="table-wrap permissions-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.permissions.jobRole}</th>
                  {PERMISSION_KEYS.map((key) => (
                    <th key={key}>{t.permissions.keys[key]}</th>
                  ))}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredJobRoles.map((role) => {
                  const keys = currentRoleKeys(role);
                  const isDirty = role.id in dirtyRoles;
                  return (
                    <tr key={role.id}>
                      <td style={{ fontWeight: 700 }}>
                        {role.name_en || role.name}
                        <div className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                          {role.department_name_en || role.department_name}
                        </div>
                      </td>
                      {PERMISSION_KEYS.map((key) => (
                        <td key={key} style={{ textAlign: 'center' }}>
                          <input type="checkbox" checked={keys.includes(key)} onChange={() => toggleRole(role, key)} />
                        </td>
                      ))}
                      <td>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={!isDirty || savingRoleId === role.id}
                          onClick={() => saveRole(role)}
                        >
                          {savingRoleId === role.id ? t.common.loading : t.common.save}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {filteredJobRoles.length === 0 && (
                  <tr>
                    <td colSpan={PERMISSION_KEYS.length + 2}>
                      <div className="empty-state">{jobRoles.length === 0 ? t.permissions.emptyJobRoles : t.permissions.noResults}</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
