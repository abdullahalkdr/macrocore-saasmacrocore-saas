import { FormEvent, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { ApiError } from '../api/client';
import { useDepartmentsStore, Department } from '../store/useDepartmentsStore';
import PageHeader from '../components/PageHeader';
import Tag from '../components/Tag';

// MIGRATION_048 — Settings > Departments. Admin/manager-only CRUD for a
// company's own corporate departments (HR / Operations / IT / Marketing /
// Finance / Legal by default, freely renamed/added/deleted afterward).
// Single flat table, no tabs — mirrors the Categories tab of
// ServiceCatalogSettingsPage.tsx exactly (inline-editable rows synced from
// the store, one "add new" row/form, save/delete per row with its own
// loading + saved-flash state), just without the nested request-types/
// custom-fields levels that page needs and this one doesn't.
export default function DepartmentsPage() {
  const t = useT();

  const departments = useDepartmentsStore((s) => s.departments);
  const loading = useDepartmentsStore((s) => s.loading);
  const fetchAll = useDepartmentsStore((s) => s.fetchAll);
  const createDepartment = useDepartmentsStore((s) => s.createDepartment);
  const updateDepartment = useDepartmentsStore((s) => s.updateDepartment);
  const removeDepartment = useDepartmentsStore((s) => s.removeDepartment);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null); // a row id, or 'new'
  const [savedId, setSavedId] = useState<string | null>(null);

  function flashSaved(id: string) {
    setSavedId(id);
    setTimeout(() => setSavedId((cur) => (cur === id ? null : cur)), 2000);
  }

  interface DepartmentDraft {
    name: string;
    name_en: string;
  }
  const EMPTY_DEPARTMENT: DepartmentDraft = { name: '', name_en: '' };
  const [drafts, setDrafts] = useState<Record<string, DepartmentDraft>>({});
  const [newDepartment, setNewDepartment] = useState<DepartmentDraft>(EMPTY_DEPARTMENT);

  useEffect(() => {
    setDrafts((d) => {
      const next = { ...d };
      for (const dep of departments) {
        next[dep.id] = { name: dep.name, name_en: dep.name_en };
      }
      return next;
    });
  }, [departments]);

  async function handleSave(id: string) {
    const draft = drafts[id];
    if (!draft || !draft.name.trim() || !draft.name_en.trim()) return setError(t.departments.nameRequired);
    setSavingId(id);
    setError(null);
    try {
      await updateDepartment(id, { name: draft.name.trim(), name_en: draft.name_en.trim() });
      flashSaved(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.departments.saveFailed);
    } finally {
      setSavingId(null);
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!newDepartment.name.trim() || !newDepartment.name_en.trim()) return setError(t.departments.nameRequired);
    setSavingId('new');
    setError(null);
    try {
      await createDepartment({ name: newDepartment.name.trim(), name_en: newDepartment.name_en.trim() });
      setNewDepartment(EMPTY_DEPARTMENT);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.departments.saveFailed);
    } finally {
      setSavingId(null);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm(t.departments.deleteConfirm)) return;
    setSavingId(id);
    setError(null);
    try {
      await removeDepartment(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.departments.deleteFailed);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div>
      <PageHeader title={t.departments.title} subtitle={t.departments.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="card-body">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.departments.nameLabel}</th>
                  <th>{t.departments.nameEnLabel}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {departments.map((dep: Department) => {
                  const draft = drafts[dep.id] ?? EMPTY_DEPARTMENT;
                  return (
                    <tr key={dep.id}>
                      <td>
                        <input value={draft.name} onChange={(e) => setDrafts((d) => ({ ...d, [dep.id]: { ...d[dep.id], name: e.target.value } }))} />
                      </td>
                      <td>
                        <input value={draft.name_en} onChange={(e) => setDrafts((d) => ({ ...d, [dep.id]: { ...d[dep.id], name_en: e.target.value } }))} />
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-primary btn-sm" type="button" onClick={() => handleSave(dep.id)} disabled={savingId === dep.id}>
                          {savingId === dep.id ? t.common.loading : t.common.save}
                        </button>{' '}
                        {savedId === dep.id && <Tag color="green">{t.departments.saved}</Tag>}{' '}
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => handleDelete(dep.id)} disabled={savingId === dep.id}>
                          {t.common.delete}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {departments.length === 0 && !loading && (
                  <tr>
                    <td colSpan={3}>
                      <div className="empty-state">{t.departments.empty}</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="hr" style={{ margin: '16px 0' }} />

          <form onSubmit={handleAdd} className="form-row">
            <div className="field" style={{ flex: 1 }}>
              <label>{t.departments.nameLabel}</label>
              <input value={newDepartment.name} onChange={(e) => setNewDepartment((d) => ({ ...d, name: e.target.value }))} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{t.departments.nameEnLabel}</label>
              <input value={newDepartment.name_en} onChange={(e) => setNewDepartment((d) => ({ ...d, name_en: e.target.value }))} />
            </div>
            <div className="field" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" type="submit" disabled={savingId === 'new'}>
                {savingId === 'new' ? t.common.loading : t.departments.addDepartment}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
