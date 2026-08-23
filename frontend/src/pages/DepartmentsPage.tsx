import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { get, ApiError } from '../api/client';
import { useDepartmentsStore, Department } from '../store/useDepartmentsStore';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import Tag from '../components/Tag';
import { IconPlus, IconEdit, IconTrash } from '../components/Icon';

// MIGRATION_049 — Settings > Corporate Departments (formerly the simple flat
// "Departments" page from MIGRATION_048). Enterprise upgrade: a Parent/Child
// org hierarchy, a manager per department (an employees row), a free-text
// cost center tag, active/inactive status, an employee headcount, and a
// "Manage Roles" action that opens each department's own job_roles list
// (moved out of the old hardcoded frontend catalog — see
// ../constants — that file no longer exists; roles are fetched from the DB
// via useDepartmentsStore, embedded on each department node).
//
// The table is a simple depth-indented flat render of the tree (renderRows
// recurses into children) rather than a real collapsible tree widget — with
// a handful of departments per company this reads fine and avoids building
// tree-UI machinery nobody asked for.

interface EmployeeOption {
  id: string;
  name: string;
}

interface DepartmentFormState {
  name: string;
  name_en: string;
  parent_department_id: string;
  manager_id: string;
  cost_center_code: string;
  status: 'active' | 'inactive';
}

function emptyDepartmentForm(): DepartmentFormState {
  return { name: '', name_en: '', parent_department_id: '', manager_id: '', cost_center_code: '', status: 'active' };
}

export default function DepartmentsPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);

  const departmentTree = useDepartmentsStore((s) => s.departmentTree);
  const departments = useDepartmentsStore((s) => s.departments); // flat — for pickers
  const loading = useDepartmentsStore((s) => s.loading);
  const fetchAll = useDepartmentsStore((s) => s.fetchAll);
  const createDepartment = useDepartmentsStore((s) => s.createDepartment);
  const updateDepartment = useDepartmentsStore((s) => s.updateDepartment);
  const removeDepartment = useDepartmentsStore((s) => s.removeDepartment);
  const createRole = useDepartmentsStore((s) => s.createRole);
  const updateRole = useDepartmentsStore((s) => s.updateRole);
  const removeRole = useDepartmentsStore((s) => s.removeRole);

  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAll();
    get<{ employees: EmployeeOption[] }>('/employees')
      .then((r) => setEmployees(r.employees.map((e) => ({ id: e.id, name: e.name }))))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<DepartmentFormState>(emptyDepartmentForm());
  const [saving, setSaving] = useState(false);

  const [rolesForId, setRolesForId] = useState<string | null>(null);
  const rolesForDept = rolesForId ? departments.find((d) => d.id === rolesForId) || null : null;

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function displayName(d: Pick<Department, 'name' | 'name_en'>): string {
    return lang === 'ar' ? d.name : d.name_en || d.name;
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyDepartmentForm());
    setOpen(true);
  }
  function openEdit(d: Department) {
    setEditingId(d.id);
    setForm({
      name: d.name,
      name_en: d.name_en,
      parent_department_id: d.parent_department_id || '',
      manager_id: d.manager_id || '',
      cost_center_code: d.cost_center_code || '',
      status: d.status,
    });
    setOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.name_en.trim()) return setError(t.departments.nameRequired);
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        name_en: form.name_en.trim(),
        parent_department_id: form.parent_department_id || null,
        manager_id: form.manager_id || null,
        cost_center_code: form.cost_center_code.trim() || null,
        status: form.status,
      };
      if (editingId) await updateDepartment(editingId, payload);
      else await createDepartment(payload);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.departments.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const id = confirmDeleteId;
    if (!id) return;
    setConfirmDeleteId(null);
    setError(null);
    try {
      await removeDepartment(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.departments.deleteFailed);
    }
  }

  function renderRows(nodes: Department[], depth: number): ReactNode[] {
    return nodes.flatMap((d) => [
      <tr key={d.id}>
        <td style={{ fontWeight: depth === 0 ? 700 : 500, paddingInlineStart: depth * 22 }}>
          {depth > 0 ? `— ${displayName(d)}` : displayName(d)}
        </td>
        <td>{d.cost_center_code || '—'}</td>
        <td>{d.manager ? d.manager.name : '—'}</td>
        <td>
          <Tag color={d.status === 'active' ? 'green' : 'gray'}>{d.status === 'active' ? t.common.active : t.common.inactive}</Tag>
        </td>
        <td className="num">{d.employee_count}</td>
        <td style={{ whiteSpace: 'nowrap' }}>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setRolesForId(d.id)}>
            {t.departments.manageRoles}
          </button>{' '}
          <button className="icon-btn" title={t.common.delete} onClick={() => openEdit(d)}>
            <IconEdit />
          </button>
          <button className="icon-btn" title={t.common.delete} onClick={() => setConfirmDeleteId(d.id)}>
            <IconTrash />
          </button>
        </td>
      </tr>,
      ...(d.children && d.children.length > 0 ? renderRows(d.children, depth + 1) : []),
    ]);
  }

  return (
    <div>
      <PageHeader title={t.departments.title} subtitle={t.departments.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="card-body">
          <div className="section-title-row">
            <span className="muted">{departments.length}</span>
            <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
              <IconPlus /> {t.departments.addDepartment}
            </button>
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.departments.colDepartment}</th>
                  <th>{t.departments.colCostCenter}</th>
                  <th>{t.departments.colManager}</th>
                  <th>{t.departments.colStatus}</th>
                  <th className="num">{t.departments.colEmployees}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {renderRows(departmentTree, 0)}
                {departmentTree.length === 0 && !loading && (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty-state">{t.departments.empty}</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {open && (
        <Modal
          title={editingId ? t.departments.editDepartment : t.departments.addDepartment}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="department-form" disabled={saving}>
                {saving ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="department-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.departments.nameLabel}</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
            </div>
            <div className="field">
              <label>{t.departments.nameEnLabel}</label>
              <input value={form.name_en} onChange={(e) => setForm({ ...form, name_en: e.target.value })} required />
            </div>
            <div className="field">
              <label>{t.departments.parentLabel}</label>
              <select value={form.parent_department_id} onChange={(e) => setForm({ ...form, parent_department_id: e.target.value })}>
                <option value="">{t.departments.parentNone}</option>
                {departments
                  .filter((d) => d.id !== editingId)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {displayName(d)}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label>{t.departments.managerLabel}</label>
              <select value={form.manager_id} onChange={(e) => setForm({ ...form, manager_id: e.target.value })}>
                <option value="">{t.departments.managerNone}</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.departments.costCenterLabel}</label>
              <input value={form.cost_center_code} onChange={(e) => setForm({ ...form, cost_center_code: e.target.value })} />
            </div>
            <div className="field">
              <label>{t.departments.colStatus}</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'inactive' })}>
                <option value="active">{t.common.active}</option>
                <option value="inactive">{t.common.inactive}</option>
              </select>
            </div>
          </form>
        </Modal>
      )}

      {rolesForDept && (
        <ManageRolesModal
          department={rolesForDept}
          onClose={() => setRolesForId(null)}
          createRole={createRole}
          updateRole={updateRole}
          removeRole={removeRole}
        />
      )}

      {confirmDeleteId && (
        <ConfirmDialog
          message={t.departments.deleteConfirm}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Manage Roles modal — Add/Edit/Delete job_roles for one department.
// ---------------------------------------------------------------------------------
interface RoleDraft {
  name: string;
  name_en: string;
}

function ManageRolesModal({
  department,
  onClose,
  createRole,
  updateRole,
  removeRole,
}: {
  department: Department;
  onClose: () => void;
  createRole: (departmentId: string, data: { name: string; name_en?: string }) => Promise<void>;
  updateRole: (id: string, data: { name?: string; name_en?: string }) => Promise<void>;
  removeRole: (id: string) => Promise<void>;
}) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);

  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null); // a role id, or 'new'
  const [drafts, setDrafts] = useState<Record<string, RoleDraft>>({});
  const [newRole, setNewRole] = useState<RoleDraft>({ name: '', name_en: '' });
  const [confirmDeleteRoleId, setConfirmDeleteRoleId] = useState<string | null>(null);

  useEffect(() => {
    setDrafts(Object.fromEntries(department.roles.map((r) => [r.id, { name: r.name, name_en: r.name_en || '' }])));
  }, [department.roles]);

  function draftFor(id: string): RoleDraft {
    return drafts[id] ?? { name: '', name_en: '' };
  }

  async function handleSave(id: string) {
    const draft = draftFor(id);
    if (!draft.name.trim()) return setError(t.departments.roleNameRequired);
    setSavingId(id);
    setError(null);
    try {
      await updateRole(id, { name: draft.name.trim(), name_en: draft.name_en.trim() || undefined });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.departments.saveFailed);
    } finally {
      setSavingId(null);
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!newRole.name.trim()) return setError(t.departments.roleNameRequired);
    setSavingId('new');
    setError(null);
    try {
      await createRole(department.id, { name: newRole.name.trim(), name_en: newRole.name_en.trim() || undefined });
      setNewRole({ name: '', name_en: '' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.departments.saveFailed);
    } finally {
      setSavingId(null);
    }
  }

  async function handleDelete() {
    const id = confirmDeleteRoleId;
    if (!id) return;
    setConfirmDeleteRoleId(null);
    setSavingId(id);
    setError(null);
    try {
      await removeRole(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.departments.deleteFailed);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <>
    <Modal title={`${t.departments.manageRolesTitle} — ${lang === 'ar' ? department.name : department.name_en}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}

      <div className="role-list">
        <div className="role-row role-row-head">
          <span>{t.departments.roleNameLabel}</span>
          <span>{t.departments.roleNameEnLabel}</span>
          <span />
        </div>
        {department.roles.map((r) => (
          <div className="role-row" key={r.id}>
            <input
              value={draftFor(r.id).name}
              onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: { ...draftFor(r.id), name: e.target.value } }))}
            />
            <input
              value={draftFor(r.id).name_en}
              onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: { ...draftFor(r.id), name_en: e.target.value } }))}
            />
            <div className="role-row-actions">
              <button className="btn btn-primary btn-sm" type="button" onClick={() => handleSave(r.id)} disabled={savingId === r.id}>
                {savingId === r.id ? t.common.loading : t.common.save}
              </button>
              <button className="icon-btn" onClick={() => setConfirmDeleteRoleId(r.id)}>
                <IconTrash />
              </button>
            </div>
          </div>
        ))}
        {department.roles.length === 0 && <div className="empty-state">{t.departments.rolesEmpty}</div>}
      </div>

      <div className="hr" style={{ margin: '14px 0' }} />

      <form onSubmit={handleAdd} className="form-row">
        <div className="field" style={{ flex: 1 }}>
          <label>{t.departments.roleNameLabel}</label>
          <input value={newRole.name} onChange={(e) => setNewRole((r) => ({ ...r, name: e.target.value }))} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>{t.departments.roleNameEnLabel}</label>
          <input value={newRole.name_en} onChange={(e) => setNewRole((r) => ({ ...r, name_en: e.target.value }))} />
        </div>
        <div className="field" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" type="submit" disabled={savingId === 'new'}>
            {savingId === 'new' ? t.common.loading : t.departments.addRole}
          </button>
        </div>
      </form>
    </Modal>

    {confirmDeleteRoleId && (
      <ConfirmDialog
        message={t.departments.deleteRoleConfirm}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDeleteRoleId(null)}
      />
    )}
    </>
  );
}
