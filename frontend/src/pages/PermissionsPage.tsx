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

const PERMISSION_KEYS = ['approve_leave', 'manual_attendance', 'edit_waste', 'edit_expenses'] as const;
type PermissionKey = (typeof PERMISSION_KEYS)[number];

export default function PermissionsPage() {
  const t = useT();
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [dirty, setDirty] = useState<Record<string, string[]>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function load() {
    get<{ employees: EmployeeRow[] }>('/permissions')
      .then((r) => setEmployees(r.employees))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.permissions.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  function currentKeys(emp: EmployeeRow): string[] {
    return dirty[emp.id] ?? emp.permission_keys;
  }

  function toggle(emp: EmployeeRow, key: PermissionKey) {
    const keys = currentKeys(emp);
    const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
    setDirty((d) => ({ ...d, [emp.id]: next }));
  }

  async function save(emp: EmployeeRow) {
    setError(null);
    setNotice(null);
    setSavingId(emp.id);
    try {
      await put(`/permissions/${emp.id}`, { permission_keys: currentKeys(emp) });
      setNotice(t.permissions.saved);
      load();
      setDirty((d) => {
        const next = { ...d };
        delete next[emp.id];
        return next;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.permissions.saveFailed);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div>
      <PageHeader title={t.permissions.title} subtitle={t.permissions.subtitle} />
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.permissions.employee}</th>
                <th>{t.permissions.keys.approve_leave}</th>
                <th>{t.permissions.keys.manual_attendance}</th>
                <th>{t.permissions.keys.edit_waste}</th>
                <th>{t.permissions.keys.edit_expenses}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => {
                const keys = currentKeys(emp);
                const isDirty = emp.id in dirty;
                return (
                  <tr key={emp.id}>
                    <td style={{ fontWeight: 700 }}>{emp.full_name || emp.email}</td>
                    {PERMISSION_KEYS.map((key) => (
                      <td key={key} style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={keys.includes(key)} onChange={() => toggle(emp, key)} />
                      </td>
                    ))}
                    <td>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!isDirty || savingId === emp.id}
                        onClick={() => save(emp)}
                      >
                        {savingId === emp.id ? t.common.loading : t.common.save}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {employees.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">{t.permissions.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
