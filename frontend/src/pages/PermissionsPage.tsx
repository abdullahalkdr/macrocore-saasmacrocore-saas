import { useEffect, useState } from 'react';
import { get, put, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import { IconClose } from '../components/Icon';

interface EmployeeRow {
  id: string;
  full_name: string | null;
  email: string;
  permission_keys: string[];
  // MIGRATION_054 layer — permission keys this user already has via their job role
  // (job_role_permissions, resolved server-side through users.employee_id ->
  // employees.job_role_id). Read-only here: individual grants below can only ADD on
  // top of this, never remove it — same rule the backend enforces.
  inherited_keys: string[];
}

// MIGRATION_054 — a job_roles row (across all departments), with its currently-granted
// job_role_permissions.
interface JobRoleRow {
  id: string;
  name: string;
  name_en: string | null;
  department_id: string;
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
  const lang = useLangStore((s) => s.lang);
  const [tab, setTab] = useState<'user' | 'jobRole'>('user');

  // job_roles/departments are stored bilingually (name = Arabic, name_en = English) —
  // same convention EmployeesPage.tsx's roleLabel()/deptLabel() already follow. Bug fix:
  // this page was previously always preferring name_en regardless of active UI language,
  // so job role/department names showed in English even with lang === 'ar'.
  function localized(name: string, nameEn: string | null): string {
    return lang === 'ar' ? name : nameEn || name;
  }

  // --- By-employee tab: search-and-select (mirrors the By Job Role tab's cascading
  // UX) — pick one employee via autocomplete instead of scrolling a 16-column matrix. ---
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [dirtyUsers, setDirtyUsers] = useState<Record<string, string[]>>({});
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [showEmployeeSuggestions, setShowEmployeeSuggestions] = useState(false);

  // --- By-job-role tab: cascading Department -> Job Role selection (replaces the old
  // full matrix table, which became unusable once there were dozens of roles x 16
  // permission columns — pick one role at a time instead of scanning a giant grid). ---
  const [jobRoles, setJobRoles] = useState<JobRoleWithGrants[]>([]);
  const [dirtyRoles, setDirtyRoles] = useState<Record<string, string[]>>({});
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [selectedDeptId, setSelectedDeptId] = useState('');
  const [selectedRoleId, setSelectedRoleId] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Client-side only — the employee list is already scoped to one company (small enough
  // to filter in the browser, no need for a server round-trip per keystroke).
  const [userSearch, setUserSearch] = useState('');
  const filteredEmployees = employees.filter((e) =>
    (e.full_name || e.email).toLowerCase().includes(userSearch.trim().toLowerCase())
  );
  const selectedEmployee = employees.find((e) => e.id === selectedEmployeeId) ?? null;

  // Departments derived from the job_roles list itself (each role row already carries
  // its department id/name/name_en) — no separate departments fetch needed.
  const departmentOptions: { id: string; name: string; name_en: string | null }[] = [];
  const seenDept = new Set<string>();
  for (const r of jobRoles) {
    if (!seenDept.has(r.department_id)) {
      seenDept.add(r.department_id);
      departmentOptions.push({ id: r.department_id, name: r.department_name, name_en: r.department_name_en });
    }
  }
  departmentOptions.sort((a, b) => localized(a.name, a.name_en).localeCompare(localized(b.name, b.name_en)));

  const rolesForSelectedDept = jobRoles
    .filter((r) => r.department_id === selectedDeptId)
    .sort((a, b) => localized(a.name, a.name_en).localeCompare(localized(b.name, b.name_en)));

  const selectedRole = jobRoles.find((r) => r.id === selectedRoleId) ?? null;

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
          {employees.length === 0 ? (
            <div className="empty-state">{t.permissions.empty}</div>
          ) : (
            <>
              <div className="field" style={{ maxWidth: 420, marginBottom: 12, position: 'relative' }}>
                <label>{t.permissions.employee}</label>
                {selectedEmployee ? (
                  <div className="invite-row" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{selectedEmployee.full_name || selectedEmployee.email}</div>
                      {selectedEmployee.full_name && <div className="muted">{selectedEmployee.email}</div>}
                    </div>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => {
                        setSelectedEmployeeId('');
                        setUserSearch('');
                      }}
                    >
                      <IconClose size={16} />
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      type="text"
                      value={userSearch}
                      onChange={(e) => {
                        setUserSearch(e.target.value);
                        setShowEmployeeSuggestions(true);
                      }}
                      onFocus={() => setShowEmployeeSuggestions(true)}
                      onBlur={() => setTimeout(() => setShowEmployeeSuggestions(false), 150)}
                      placeholder={t.permissions.searchEmployee}
                      autoComplete="off"
                    />
                    {showEmployeeSuggestions && (
                      <div className="autocomplete-list">
                        {filteredEmployees.length === 0 && <div className="autocomplete-item muted">{t.permissions.noResults}</div>}
                        {filteredEmployees.slice(0, 8).map((emp) => (
                          <div
                            key={emp.id}
                            className="autocomplete-item"
                            onMouseDown={(ev) => {
                              ev.preventDefault();
                              setSelectedEmployeeId(emp.id);
                              setUserSearch('');
                              setShowEmployeeSuggestions(false);
                            }}
                          >
                            <div style={{ fontWeight: 700 }}>{emp.full_name || emp.email}</div>
                            {emp.full_name && <div className="muted" style={{ fontSize: 11 }}>{emp.email}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              {!selectedEmployee && <div className="empty-state">{t.permissions.noEmployeeSelected}</div>}

              {selectedEmployee && (
                <>
                  <div className="hr" />
                  <div className="muted" style={{ marginBottom: 10 }}>{t.permissions.inheritedHint}</div>
                  <div className="permission-check-grid">
                    {PERMISSION_KEYS.map((key) => {
                      const keys = currentUserKeys(selectedEmployee);
                      const isInherited = selectedEmployee.inherited_keys.includes(key);
                      const isChecked = isInherited || keys.includes(key);
                      return (
                        <label
                          key={key}
                          className={`permission-check-item${isInherited ? ' inherited' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={isInherited}
                            onChange={() => toggleUser(selectedEmployee, key)}
                          />
                          <span>{t.permissions.keys[key]}</span>
                          {isInherited && <span className="tag amber" style={{ marginInlineStart: 'auto' }}>{t.permissions.inheritedBadge}</span>}
                        </label>
                      );
                    })}
                  </div>
                  <button
                    className="btn btn-primary"
                    disabled={!(selectedEmployee.id in dirtyUsers) || savingUserId === selectedEmployee.id}
                    onClick={() => saveUser(selectedEmployee)}
                  >
                    {savingUserId === selectedEmployee.id ? t.common.loading : t.permissions.savePermissions}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'jobRole' && (
        <div className="card">
          {jobRoles.length === 0 ? (
            <div className="empty-state">{t.permissions.emptyJobRoles}</div>
          ) : (
            <>
              <div className="form-row">
                <div className="field">
                  <label>{t.permissions.department}</label>
                  <select
                    value={selectedDeptId}
                    onChange={(e) => {
                      setSelectedDeptId(e.target.value);
                      setSelectedRoleId('');
                    }}
                  >
                    <option value="">{t.permissions.selectDepartmentPlaceholder}</option>
                    {departmentOptions.map((d) => (
                      <option key={d.id} value={d.id}>
                        {localized(d.name, d.name_en)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>{t.permissions.jobRole}</label>
                  <select
                    value={selectedRoleId}
                    onChange={(e) => setSelectedRoleId(e.target.value)}
                    disabled={!selectedDeptId}
                  >
                    <option value="">{t.permissions.selectJobRolePlaceholder}</option>
                    {rolesForSelectedDept.map((r) => (
                      <option key={r.id} value={r.id}>
                        {localized(r.name, r.name_en)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {!selectedRole && <div className="empty-state">{t.permissions.noRoleSelected}</div>}

              {selectedRole && (
                <>
                  <div className="hr" />
                  <div className="section-title-row">
                    <div>
                      <strong>{localized(selectedRole.name, selectedRole.name_en)}</strong>
                      <div className="muted">{localized(selectedRole.department_name, selectedRole.department_name_en)}</div>
                    </div>
                  </div>
                  <div className="permission-check-grid">
                    {PERMISSION_KEYS.map((key) => {
                      const keys = currentRoleKeys(selectedRole);
                      return (
                        <label key={key} className="permission-check-item">
                          <input
                            type="checkbox"
                            checked={keys.includes(key)}
                            onChange={() => toggleRole(selectedRole, key)}
                          />
                          {t.permissions.keys[key]}
                        </label>
                      );
                    })}
                  </div>
                  <button
                    className="btn btn-primary"
                    disabled={!(selectedRole.id in dirtyRoles) || savingRoleId === selectedRole.id}
                    onClick={() => saveRole(selectedRole)}
                  >
                    {savingRoleId === selectedRole.id ? t.common.loading : t.permissions.savePermissions}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
