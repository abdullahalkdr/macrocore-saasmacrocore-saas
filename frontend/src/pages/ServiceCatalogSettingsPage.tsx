import { FormEvent, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { get, ApiError } from '../api/client';
import {
  useServiceCatalogStore,
  ServiceCategory,
  ServiceRequestType,
  ServiceCustomField,
  CustomFieldType,
  RequestTypeApprovalStep,
} from '../store/useServiceCatalogStore';
import { useDepartmentsStore } from '../store/useDepartmentsStore';
import PageHeader from '../components/PageHeader';
import Tag from '../components/Tag';
import ConfirmDialog from '../components/ConfirmDialog';
import Modal from '../components/Modal';
import { IconPlus, IconTrash, IconApproval } from '../components/Icon';

const FIELD_TYPES: CustomFieldType[] = ['text', 'textarea', 'number', 'dropdown'];

// MIGRATION_072 — the Approval Workflow modal's job_role step picker needs the flat,
// company-wide job role list (not scoped to one department the way DepartmentsPage's
// roles are) — same endpoint PermissionsPage.tsx already uses. Module-scoped so both
// the page component and ApprovalWorkflowModal below can share the type.
interface JobRoleOption {
  id: string;
  name: string;
  name_en: string | null;
  department_name: string;
  department_name_en: string | null;
}

// ITSM pivot Step 3 — Settings > Service Catalog. Admin/manager-only CRUD for
// the 3 resources MIGRATION_047 introduced (service_categories ->
// service_request_types -> service_custom_fields). Mirrors
// SLAManagementPage's/the old ticket_categories admin tab's conventions:
// inline-editable rows synced from the store, one "add new" row/form per
// table, save/delete per row with its own loading + saved-flash state.
//
// Backend enforces admin/manager (requireRole('admin','manager')) on every
// write here, same as ticket_categories — this page is gated MANAGER_ROLES
// in App.tsx, not admin-only, to match what the API actually allows (see
// App.tsx's comment on that route).
export default function ServiceCatalogSettingsPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);

  const categories = useServiceCatalogStore((s) => s.categories);
  const requestTypes = useServiceCatalogStore((s) => s.requestTypes);
  const customFields = useServiceCatalogStore((s) => s.customFields);
  const loading = useServiceCatalogStore((s) => s.loading);
  const fetchAll = useServiceCatalogStore((s) => s.fetchAll);
  const createCategory = useServiceCatalogStore((s) => s.createCategory);
  const updateCategory = useServiceCatalogStore((s) => s.updateCategory);
  const removeCategory = useServiceCatalogStore((s) => s.removeCategory);
  const createRequestType = useServiceCatalogStore((s) => s.createRequestType);
  const updateRequestType = useServiceCatalogStore((s) => s.updateRequestType);
  const removeRequestType = useServiceCatalogStore((s) => s.removeRequestType);
  const createCustomField = useServiceCatalogStore((s) => s.createCustomField);
  const updateCustomField = useServiceCatalogStore((s) => s.updateCustomField);
  const removeCustomField = useServiceCatalogStore((s) => s.removeCustomField);
  const setApprovalSteps = useServiceCatalogStore((s) => s.setApprovalSteps);

  // MIGRATION_071 — the Request Types tab's Department picker below needs
  // the flat department list (divisions + sections, including the IT
  // Department Template's tree if applied).
  const departments = useDepartmentsStore((s) => s.departments);
  const fetchAllDepartments = useDepartmentsStore((s) => s.fetchAll);

  const [jobRoles, setJobRoles] = useState<JobRoleOption[]>([]);

  useEffect(() => {
    fetchAll();
    fetchAllDepartments();
    get<{ job_roles: JobRoleOption[] }>('/permissions/job-roles')
      .then((r) => setJobRoles(r.job_roles))
      .catch(() => {});
  }, [fetchAll, fetchAllDepartments]);

  const [approvalModalRequestType, setApprovalModalRequestType] = useState<ServiceRequestType | null>(null);

  const [tab, setTab] = useState<'categories' | 'requestTypes' | 'customFields'>('categories');
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null); // a row id, or 'new'
  const [savedId, setSavedId] = useState<string | null>(null);
  // Pending destructive action awaiting confirmation via <ConfirmDialog> (replaces
  // window.confirm() -- see Global UI/UX polish Step 4). One shared slot covers all
  // 3 delete kinds on this page since only one confirm dialog can be open at a time.
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'category' | 'requestType' | 'field'; id: string } | null>(null);

  function flashSaved(id: string) {
    setSavedId(id);
    setTimeout(() => setSavedId((cur) => (cur === id ? null : cur)), 2000);
  }

  function localName(item: { name: string; name_en: string | null }): string {
    return lang === 'ar' ? item.name : item.name_en || item.name;
  }

  // --- Categories tab ---
  interface CategoryDraft {
    name: string;
    name_en: string;
    description: string;
    description_en: string;
    icon: string;
  }
  const EMPTY_CATEGORY: CategoryDraft = { name: '', name_en: '', description: '', description_en: '', icon: '' };
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, CategoryDraft>>({});
  const [newCategory, setNewCategory] = useState<CategoryDraft>(EMPTY_CATEGORY);

  useEffect(() => {
    setCategoryDrafts((d) => {
      const next = { ...d };
      for (const c of categories) {
        next[c.id] = { name: c.name, name_en: c.name_en || '', description: c.description || '', description_en: c.description_en || '', icon: c.icon || '' };
      }
      return next;
    });
  }, [categories]);

  async function handleSaveCategory(id: string) {
    const draft = categoryDrafts[id];
    if (!draft || !draft.name.trim()) return setError(t.serviceCatalog.nameRequired);
    setSavingId(id);
    setError(null);
    try {
      await updateCategory(id, {
        name: draft.name.trim(),
        name_en: draft.name_en.trim() || null,
        description: draft.description.trim() || null,
        description_en: draft.description_en.trim() || null,
        icon: draft.icon.trim() || null,
      });
      flashSaved(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.serviceCatalog.categorySaveFailed);
    } finally {
      setSavingId(null);
    }
  }

  async function handleAddCategory(e: FormEvent) {
    e.preventDefault();
    if (!newCategory.name.trim()) return setError(t.serviceCatalog.nameRequired);
    setSavingId('new');
    setError(null);
    try {
      await createCategory({
        name: newCategory.name.trim(),
        name_en: newCategory.name_en.trim() || null,
        description: newCategory.description.trim() || null,
        description_en: newCategory.description_en.trim() || null,
        icon: newCategory.icon.trim() || null,
      });
      setNewCategory(EMPTY_CATEGORY);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.serviceCatalog.categorySaveFailed);
    } finally {
      setSavingId(null);
    }
  }

  async function handleDeleteCategory(id: string) {
    setSavingId(id);
    setError(null);
    try {
      await removeCategory(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.serviceCatalog.categoryDeleteFailed);
    } finally {
      setSavingId(null);
    }
  }

  // --- Request types tab ---
  interface RequestTypeDraft {
    category_id: string;
    department_id: string;
    name: string;
    name_en: string;
    is_hr_sensitive: boolean;
  }
  const EMPTY_REQUEST_TYPE: RequestTypeDraft = { category_id: '', department_id: '', name: '', name_en: '', is_hr_sensitive: false };
  const [rtDrafts, setRtDrafts] = useState<Record<string, RequestTypeDraft>>({});
  const [newRequestType, setNewRequestType] = useState<RequestTypeDraft>(EMPTY_REQUEST_TYPE);

  useEffect(() => {
    setRtDrafts((d) => {
      const next = { ...d };
      for (const rt of requestTypes) {
        next[rt.id] = {
          category_id: rt.category_id || '',
          department_id: rt.department_id || '',
          name: rt.name,
          name_en: rt.name_en || '',
          is_hr_sensitive: rt.is_hr_sensitive,
        };
      }
      return next;
    });
  }, [requestTypes]);

  async function handleSaveRequestType(id: string) {
    const draft = rtDrafts[id];
    if (!draft || !draft.name.trim()) return setError(t.serviceCatalog.nameRequired);
    setSavingId(id);
    setError(null);
    try {
      await updateRequestType(id, {
        category_id: draft.category_id || null,
        department_id: draft.department_id || null,
        name: draft.name.trim(),
        name_en: draft.name_en.trim() || null,
        is_hr_sensitive: draft.is_hr_sensitive,
      });
      flashSaved(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.serviceCatalog.requestTypeSaveFailed);
    } finally {
      setSavingId(null);
    }
  }

  async function handleAddRequestType(e: FormEvent) {
    e.preventDefault();
    if (!newRequestType.name.trim()) return setError(t.serviceCatalog.nameRequired);
    setSavingId('new');
    setError(null);
    try {
      await createRequestType({
        category_id: newRequestType.category_id || null,
        department_id: newRequestType.department_id || null,
        name: newRequestType.name.trim(),
        name_en: newRequestType.name_en.trim() || null,
        is_hr_sensitive: newRequestType.is_hr_sensitive,
      });
      setNewRequestType(EMPTY_REQUEST_TYPE);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.serviceCatalog.requestTypeSaveFailed);
    } finally {
      setSavingId(null);
    }
  }

  async function handleDeleteRequestType(id: string) {
    setSavingId(id);
    setError(null);
    try {
      await removeRequestType(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.serviceCatalog.requestTypeDeleteFailed);
    } finally {
      setSavingId(null);
    }
  }

  // --- Custom fields tab (scoped to one selected request type at a time) ---
  const [selectedRequestTypeId, setSelectedRequestTypeId] = useState('');
  const fieldsForSelected = customFields.filter((f) => f.request_type_id === selectedRequestTypeId);

  interface FieldDraft {
    field_key: string;
    field_label: string;
    field_label_en: string;
    field_type: CustomFieldType;
    is_required: boolean;
  }
  const EMPTY_FIELD: FieldDraft = { field_key: '', field_label: '', field_label_en: '', field_type: 'text', is_required: false };
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, FieldDraft>>({});
  const [newField, setNewField] = useState<FieldDraft>(EMPTY_FIELD);

  useEffect(() => {
    setFieldDrafts((d) => {
      const next = { ...d };
      for (const f of customFields) {
        next[f.id] = { field_key: f.field_key, field_label: f.field_label, field_label_en: f.field_label_en || '', field_type: f.field_type, is_required: f.is_required };
      }
      return next;
    });
  }, [customFields]);

  function fieldTypeLabel(ft: CustomFieldType): string {
    return ft === 'text' ? t.serviceCatalog.fieldTypeText
      : ft === 'textarea' ? t.serviceCatalog.fieldTypeTextarea
      : ft === 'number' ? t.serviceCatalog.fieldTypeNumber
      : t.serviceCatalog.fieldTypeDropdown;
  }

  async function handleSaveField(id: string) {
    const draft = fieldDrafts[id];
    if (!draft || !draft.field_key.trim() || !draft.field_label.trim()) return setError(t.serviceCatalog.fieldKeyRequired);
    setSavingId(id);
    setError(null);
    try {
      await updateCustomField(id, {
        field_key: draft.field_key.trim(),
        field_label: draft.field_label.trim(),
        field_label_en: draft.field_label_en.trim() || null,
        field_type: draft.field_type,
        is_required: draft.is_required,
      });
      flashSaved(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.serviceCatalog.fieldSaveFailed);
    } finally {
      setSavingId(null);
    }
  }

  async function handleAddField(e: FormEvent) {
    e.preventDefault();
    if (!selectedRequestTypeId) return;
    if (!newField.field_key.trim() || !newField.field_label.trim()) return setError(t.serviceCatalog.fieldKeyRequired);
    setSavingId('new');
    setError(null);
    try {
      await createCustomField({
        request_type_id: selectedRequestTypeId,
        field_key: newField.field_key.trim(),
        field_label: newField.field_label.trim(),
        field_label_en: newField.field_label_en.trim() || null,
        field_type: newField.field_type,
        is_required: newField.is_required,
      });
      setNewField(EMPTY_FIELD);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.serviceCatalog.fieldSaveFailed);
    } finally {
      setSavingId(null);
    }
  }

  async function handleDeleteField(id: string) {
    setSavingId(id);
    setError(null);
    try {
      await removeCustomField(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.serviceCatalog.fieldDeleteFailed);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div>
      <PageHeader title={t.serviceCatalog.title} subtitle={t.serviceCatalog.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="tabs">
        <button type="button" className={`tab-btn${tab === 'categories' ? ' active' : ''}`} onClick={() => setTab('categories')}>
          {t.serviceCatalog.tabCategories}
        </button>
        <button type="button" className={`tab-btn${tab === 'requestTypes' ? ' active' : ''}`} onClick={() => setTab('requestTypes')}>
          {t.serviceCatalog.tabRequestTypes}
        </button>
        <button type="button" className={`tab-btn${tab === 'customFields' ? ' active' : ''}`} onClick={() => setTab('customFields')}>
          {t.serviceCatalog.tabCustomFields}
        </button>
      </div>

      {tab === 'categories' && (
        <div className="card">
          <div className="card-body">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t.serviceCatalog.nameLabel}</th>
                    <th>{t.serviceCatalog.nameEnLabel}</th>
                    <th>{t.serviceCatalog.iconLabel}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {categories.map((c: ServiceCategory) => {
                    const draft = categoryDrafts[c.id] ?? EMPTY_CATEGORY;
                    return (
                      <tr key={c.id}>
                        <td>
                          <input value={draft.name} onChange={(e) => setCategoryDrafts((d) => ({ ...d, [c.id]: { ...d[c.id], name: e.target.value } }))} />
                        </td>
                        <td>
                          <input value={draft.name_en} onChange={(e) => setCategoryDrafts((d) => ({ ...d, [c.id]: { ...d[c.id], name_en: e.target.value } }))} />
                        </td>
                        <td>
                          <input value={draft.icon} onChange={(e) => setCategoryDrafts((d) => ({ ...d, [c.id]: { ...d[c.id], icon: e.target.value } }))} style={{ width: 90 }} />
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn btn-primary btn-sm" type="button" onClick={() => handleSaveCategory(c.id)} disabled={savingId === c.id}>
                            {savingId === c.id ? t.common.loading : t.common.save}
                          </button>{' '}
                          {savedId === c.id && <Tag color="green">{t.serviceCatalog.saved}</Tag>}{' '}
                          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setPendingDelete({ kind: 'category', id: c.id })} disabled={savingId === c.id}>
                            {t.common.delete}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {categories.length === 0 && !loading && (
                    <tr>
                      <td colSpan={4}>
                        <div className="empty-state">{t.serviceCatalog.categoriesEmpty}</div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="hr" style={{ margin: '16px 0' }} />

            <form onSubmit={handleAddCategory} className="form-row">
              <div className="field" style={{ flex: 1 }}>
                <label>{t.serviceCatalog.nameLabel}</label>
                <input value={newCategory.name} onChange={(e) => setNewCategory((d) => ({ ...d, name: e.target.value }))} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>{t.serviceCatalog.nameEnLabel}</label>
                <input value={newCategory.name_en} onChange={(e) => setNewCategory((d) => ({ ...d, name_en: e.target.value }))} />
              </div>
              <div className="field" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" type="submit" disabled={savingId === 'new'}>
                  {savingId === 'new' ? t.common.loading : t.serviceCatalog.addCategory}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {tab === 'requestTypes' && (
        <div className="card">
          <div className="card-body">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                    <tr>
                    <th>{t.serviceCatalog.parentCategoryLabel}</th>
                    <th>{t.serviceCatalog.departmentLabel}</th>
                    <th>{t.serviceCatalog.nameLabel}</th>
                    <th>{t.serviceCatalog.nameEnLabel}</th>
                    <th>{t.serviceCatalog.hrSensitive}</th>
                    <th>{t.serviceCatalog.approvalColLabel}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {requestTypes.map((rt: ServiceRequestType) => {
                    const draft = rtDrafts[rt.id] ?? EMPTY_REQUEST_TYPE;
                    return (
                      <tr key={rt.id}>
                        <td>
                          <select value={draft.category_id} onChange={(e) => setRtDrafts((d) => ({ ...d, [rt.id]: { ...d[rt.id], category_id: e.target.value } }))}>
                            <option value="">{t.serviceCatalog.noParentCategory}</option>
                            {categories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {localName(c)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select value={draft.department_id} onChange={(e) => setRtDrafts((d) => ({ ...d, [rt.id]: { ...d[rt.id], department_id: e.target.value } }))}>
                            <option value="">{t.serviceCatalog.noDepartment}</option>
                            {departments.map((dep) => (
                              <option key={dep.id} value={dep.id}>
                                {localName(dep)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input value={draft.name} onChange={(e) => setRtDrafts((d) => ({ ...d, [rt.id]: { ...d[rt.id], name: e.target.value } }))} />
                        </td>
                        <td>
                          <input value={draft.name_en} onChange={(e) => setRtDrafts((d) => ({ ...d, [rt.id]: { ...d[rt.id], name_en: e.target.value } }))} />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            style={{ width: 'auto' }}
                            checked={draft.is_hr_sensitive}
                            title={t.serviceCatalog.hrSensitiveHint}
                            onChange={(e) => setRtDrafts((d) => ({ ...d, [rt.id]: { ...d[rt.id], is_hr_sensitive: e.target.checked } }))}
                          />
                        </td>
                        <td>
                          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setApprovalModalRequestType(rt)}>
                            <IconApproval size={13} />{' '}
                            {rt.requires_approval ? t.serviceCatalog.approvalOnLabel : t.serviceCatalog.approvalOffLabel}
                          </button>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn btn-primary btn-sm" type="button" onClick={() => handleSaveRequestType(rt.id)} disabled={savingId === rt.id}>
                            {savingId === rt.id ? t.common.loading : t.common.save}
                          </button>{' '}
                          {savedId === rt.id && <Tag color="green">{t.serviceCatalog.saved}</Tag>}{' '}
                          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setPendingDelete({ kind: 'requestType', id: rt.id })} disabled={savingId === rt.id}>
                            {t.common.delete}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {requestTypes.length === 0 && !loading && (
                    <tr>
                      <td colSpan={7}>
                        <div className="empty-state">{t.serviceCatalog.requestTypesEmpty}</div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="hr" style={{ margin: '16px 0' }} />

            <form onSubmit={handleAddRequestType} className="form-row" style={{ flexWrap: 'wrap' }}>
              <div className="field" style={{ flex: 1 }}>
                <label>{t.serviceCatalog.parentCategoryLabel}</label>
                <select value={newRequestType.category_id} onChange={(e) => setNewRequestType((d) => ({ ...d, category_id: e.target.value }))}>
                  <option value="">{t.serviceCatalog.noParentCategory}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {localName(c)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>{t.serviceCatalog.departmentLabel}</label>
                <select value={newRequestType.department_id} onChange={(e) => setNewRequestType((d) => ({ ...d, department_id: e.target.value }))}>
                  <option value="">{t.serviceCatalog.noDepartment}</option>
                  {departments.map((dep) => (
                    <option key={dep.id} value={dep.id}>
                      {localName(dep)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>{t.serviceCatalog.nameLabel}</label>
                <input value={newRequestType.name} onChange={(e) => setNewRequestType((d) => ({ ...d, name: e.target.value }))} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>{t.serviceCatalog.nameEnLabel}</label>
                <input value={newRequestType.name_en} onChange={(e) => setNewRequestType((d) => ({ ...d, name_en: e.target.value }))} />
              </div>
              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={newRequestType.is_hr_sensitive}
                    onChange={(e) => setNewRequestType((d) => ({ ...d, is_hr_sensitive: e.target.checked }))}
                  />
                  <span style={{ fontSize: 13 }}>{t.serviceCatalog.hrSensitive}</span>
                </label>
              </div>
              <div className="field" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" type="submit" disabled={savingId === 'new'}>
                  {savingId === 'new' ? t.common.loading : t.serviceCatalog.addRequestType}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {tab === 'customFields' && (
        <div className="card">
          <div className="card-body">
            <div className="field" style={{ maxWidth: 360, marginBottom: 16 }}>
              <label>{t.serviceCatalog.parentRequestTypeLabel}</label>
              <select value={selectedRequestTypeId} onChange={(e) => setSelectedRequestTypeId(e.target.value)}>
                <option value="">{t.serviceCatalog.selectRequestType}</option>
                {requestTypes.map((rt) => (
                  <option key={rt.id} value={rt.id}>
                    {localName(rt)}
                  </option>
                ))}
              </select>
            </div>

            {selectedRequestTypeId && (
              <>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>{t.serviceCatalog.fieldKeyLabel}</th>
                        <th>{t.serviceCatalog.fieldLabelLabel}</th>
                        <th>{t.serviceCatalog.fieldLabelEnLabel}</th>
                        <th>{t.serviceCatalog.fieldTypeLabel}</th>
                        <th>{t.serviceCatalog.isRequiredLabel}</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {fieldsForSelected.map((f: ServiceCustomField) => {
                        const draft = fieldDrafts[f.id] ?? EMPTY_FIELD;
                        return (
                          <tr key={f.id}>
                            <td>
                              <input value={draft.field_key} onChange={(e) => setFieldDrafts((d) => ({ ...d, [f.id]: { ...d[f.id], field_key: e.target.value } }))} style={{ width: 130 }} />
                            </td>
                            <td>
                              <input value={draft.field_label} onChange={(e) => setFieldDrafts((d) => ({ ...d, [f.id]: { ...d[f.id], field_label: e.target.value } }))} />
                            </td>
                            <td>
                              <input value={draft.field_label_en} onChange={(e) => setFieldDrafts((d) => ({ ...d, [f.id]: { ...d[f.id], field_label_en: e.target.value } }))} />
                            </td>
                            <td>
                              <select value={draft.field_type} onChange={(e) => setFieldDrafts((d) => ({ ...d, [f.id]: { ...d[f.id], field_type: e.target.value as CustomFieldType } }))}>
                                {FIELD_TYPES.map((ft) => (
                                  <option key={ft} value={ft}>
                                    {fieldTypeLabel(ft)}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <input
                                type="checkbox"
                                style={{ width: 'auto' }}
                                checked={draft.is_required}
                                onChange={(e) => setFieldDrafts((d) => ({ ...d, [f.id]: { ...d[f.id], is_required: e.target.checked } }))}
                              />
                            </td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              <button className="btn btn-primary btn-sm" type="button" onClick={() => handleSaveField(f.id)} disabled={savingId === f.id}>
                                {savingId === f.id ? t.common.loading : t.common.save}
                              </button>{' '}
                              {savedId === f.id && <Tag color="green">{t.serviceCatalog.saved}</Tag>}{' '}
                              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setPendingDelete({ kind: 'field', id: f.id })} disabled={savingId === f.id}>
                                {t.common.delete}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {fieldsForSelected.length === 0 && !loading && (
                        <tr>
                          <td colSpan={6}>
                            <div className="empty-state">{t.serviceCatalog.fieldsEmpty}</div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="hr" style={{ margin: '16px 0' }} />

                <form onSubmit={handleAddField} className="form-row">
                  <div className="field" style={{ flex: 1 }}>
                    <label>{t.serviceCatalog.fieldKeyLabel}</label>
                    <input value={newField.field_key} onChange={(e) => setNewField((d) => ({ ...d, field_key: e.target.value }))} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>{t.serviceCatalog.fieldLabelLabel}</label>
                    <input value={newField.field_label} onChange={(e) => setNewField((d) => ({ ...d, field_label: e.target.value }))} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>{t.serviceCatalog.fieldLabelEnLabel}</label>
                    <input value={newField.field_label_en} onChange={(e) => setNewField((d) => ({ ...d, field_label_en: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label>{t.serviceCatalog.fieldTypeLabel}</label>
                    <select value={newField.field_type} onChange={(e) => setNewField((d) => ({ ...d, field_type: e.target.value as CustomFieldType }))}>
                      {FIELD_TYPES.map((ft) => (
                        <option key={ft} value={ft}>
                          {fieldTypeLabel(ft)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" style={{ width: 'auto' }} checked={newField.is_required} onChange={(e) => setNewField((d) => ({ ...d, is_required: e.target.checked }))} />
                      <span style={{ fontSize: 13 }}>{t.serviceCatalog.isRequiredLabel}</span>
                    </label>
                  </div>
                  <div className="field" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn btn-primary" type="submit" disabled={savingId === 'new'}>
                      {savingId === 'new' ? t.common.loading : t.serviceCatalog.addField}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          message={
            pendingDelete.kind === 'category'
              ? t.serviceCatalog.deleteCategoryConfirm
              : pendingDelete.kind === 'requestType'
                ? t.serviceCatalog.deleteRequestTypeConfirm
                : t.serviceCatalog.deleteFieldConfirm
          }
          onConfirm={() => {
            const { kind, id } = pendingDelete;
            setPendingDelete(null);
            if (kind === 'category') handleDeleteCategory(id);
            else if (kind === 'requestType') handleDeleteRequestType(id);
            else handleDeleteField(id);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {approvalModalRequestType && (
        <ApprovalWorkflowModal
          requestType={approvalModalRequestType}
          jobRoles={jobRoles}
          lang={lang}
          onSave={setApprovalSteps}
          onClose={() => setApprovalModalRequestType(null)}
        />
      )}
    </div>
  );
}

// ========================================================================
// MIGRATION_072 — Approval Workflow config for one request type. Toggle +
// ordered step builder, saved together in one PUT (setApprovalSteps) so
// "requires_approval on with zero steps" can never be submitted — the Save
// button itself is disabled in that state, matching the backend's own guard.
// Mirrors DepartmentsPage.tsx's ManageRolesModal conventions (Modal wrapper,
// local draft state synced from the store's data via useEffect on open).
// ========================================================================

interface StepDraft {
  approver_type: 'department_manager' | 'job_role';
  approver_job_role_id: string;
  step_label: string;
  step_label_en: string;
  // True until the admin manually edits step_label/step_label_en — while true,
  // changing approver_type or the picked job role keeps regenerating a sensible
  // default label instead of leaving it blank. Flips to false the moment they
  // type into either label field, so their own wording is never clobbered.
  autoLabel: boolean;
}

function defaultStepLabel(
  type: 'department_manager' | 'job_role',
  jobRoleId: string,
  jobRoles: JobRoleOption[]
): { ar: string; en: string } {
  if (type === 'department_manager') {
    return { ar: 'موافقة مدير القسم المباشر', en: 'Direct department manager approval' };
  }
  const role = jobRoles.find((r) => r.id === jobRoleId);
  if (!role) return { ar: 'اعتماد صاحب مسمى وظيفي محدد', en: 'Approval by a specific job role' };
  return { ar: `اعتماد ${role.name}`, en: `Approval by ${role.name_en || role.name}` };
}

function stepFromServer(s: RequestTypeApprovalStep): StepDraft {
  return {
    approver_type: s.approver_type,
    approver_job_role_id: s.approver_job_role_id || '',
    step_label: s.step_label,
    step_label_en: s.step_label_en || '',
    autoLabel: false, // already-saved steps keep their exact saved wording until touched
  };
}

function ApprovalWorkflowModal({
  requestType,
  jobRoles,
  lang,
  onSave,
  onClose,
}: {
  requestType: ServiceRequestType;
  jobRoles: JobRoleOption[];
  lang: 'ar' | 'en';
  onSave: (
    id: string,
    requiresApproval: boolean,
    steps: Array<{ approver_type: 'department_manager' | 'job_role'; approver_job_role_id?: string | null; step_label: string; step_label_en?: string | null }>
  ) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [requiresApproval, setRequiresApproval] = useState(requestType.requires_approval);
  const [steps, setSteps] = useState<StepDraft[]>(
    requestType.approval_steps.length > 0
      ? requestType.approval_steps.map(stepFromServer)
      : []
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleToggle(next: boolean) {
    setRequiresApproval(next);
    // Turning it on with nothing configured yet — seed one sensible first step
    // instead of showing an empty list the admin has to know to add to.
    if (next && steps.length === 0) {
      const label = defaultStepLabel('department_manager', '', jobRoles);
      setSteps([{ approver_type: 'department_manager', approver_job_role_id: '', step_label: label.ar, step_label_en: label.en, autoLabel: true }]);
    }
  }

  function updateStep(i: number, patch: Partial<StepDraft>) {
    setSteps((cur) =>
      cur.map((s, idx) => {
        if (idx !== i) return s;
        const merged = { ...s, ...patch };
        if (('step_label' in patch || 'step_label_en' in patch) && (patch.step_label !== undefined || patch.step_label_en !== undefined)) {
          merged.autoLabel = false; // they typed — stop auto-regenerating this step's label
        } else if (merged.autoLabel && ('approver_type' in patch || 'approver_job_role_id' in patch)) {
          const label = defaultStepLabel(merged.approver_type, merged.approver_job_role_id, jobRoles);
          merged.step_label = label.ar;
          merged.step_label_en = label.en;
        }
        return merged;
      })
    );
  }

  function addStep() {
    const label = defaultStepLabel('department_manager', '', jobRoles);
    setSteps((cur) => [...cur, { approver_type: 'department_manager', approver_job_role_id: '', step_label: label.ar, step_label_en: label.en, autoLabel: true }]);
  }

  function removeStep(i: number) {
    setSteps((cur) => cur.filter((_, idx) => idx !== i));
  }

  const canSave = !requiresApproval || (steps.length > 0 && steps.every((s) => s.step_label.trim().length > 0 && (s.approver_type !== 'job_role' || s.approver_job_role_id)));

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(
        requestType.id,
        requiresApproval,
        requiresApproval
          ? steps.map((s) => ({
              approver_type: s.approver_type,
              approver_job_role_id: s.approver_type === 'job_role' ? s.approver_job_role_id : null,
              step_label: s.step_label.trim(),
              step_label_en: s.step_label_en.trim() || null,
            }))
          : []
      );
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.serviceCatalog.approvalSaveFailed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`${t.serviceCatalog.approvalModalTitle} — ${lang === 'ar' ? requestType.name : requestType.name_en || requestType.name}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 14 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={requiresApproval} onChange={(e) => handleToggle(e.target.checked)} />
        <span style={{ fontSize: 13, fontWeight: 700 }}>{t.serviceCatalog.requiresApprovalLabel}</span>
      </label>
      <div style={{ fontSize: 12, color: 'var(--muted, #888)', marginBottom: requiresApproval ? 14 : 0 }}>
        {t.serviceCatalog.requiresApprovalHint}
      </div>

      {requiresApproval && (
        <>
          <div className="hr" style={{ margin: '10px 0' }} />
          {steps.map((s, i) => (
            <div key={i} style={{ border: '1px solid var(--border, #e5e5e5)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 800 }}>{t.serviceCatalog.stepNumberLabel(i + 1)}</span>
                <button type="button" className="icon-btn" onClick={() => removeStep(i)} title={t.serviceCatalog.removeStep}>
                  <IconTrash />
                </button>
              </div>

              <div className="form-row" style={{ flexWrap: 'wrap' }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>{t.serviceCatalog.approverTypeLabel}</label>
                  <select
                    value={s.approver_type}
                    onChange={(e) => updateStep(i, { approver_type: e.target.value as 'department_manager' | 'job_role', approver_job_role_id: '' })}
                  >
                    <option value="department_manager">{t.serviceCatalog.approverTypeDeptManager}</option>
                    <option value="job_role">{t.serviceCatalog.approverTypeJobRole}</option>
                  </select>
                </div>
                {s.approver_type === 'job_role' && (
                  <div className="field" style={{ flex: 1 }}>
                    <label>{t.serviceCatalog.jobRoleLabel}</label>
                    <select value={s.approver_job_role_id} onChange={(e) => updateStep(i, { approver_job_role_id: e.target.value })}>
                      <option value="">{t.serviceCatalog.selectJobRolePlaceholder}</option>
                      {jobRoles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {lang === 'ar' ? r.name : r.name_en || r.name} — {lang === 'ar' ? r.department_name : r.department_name_en || r.department_name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <div className="form-row" style={{ flexWrap: 'wrap', marginTop: 6 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>{t.serviceCatalog.stepLabelAr}</label>
                  <input value={s.step_label} onChange={(e) => updateStep(i, { step_label: e.target.value })} />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>{t.serviceCatalog.stepLabelEn}</label>
                  <input value={s.step_label_en} onChange={(e) => updateStep(i, { step_label_en: e.target.value })} />
                </div>
              </div>
            </div>
          ))}

          <button type="button" className="btn btn-secondary btn-sm" onClick={addStep}>
            <IconPlus /> {t.serviceCatalog.addStep}
          </button>
        </>
      )}

      <div className="hr" style={{ margin: '14px 0' }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
          {t.common.cancel}
        </button>
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving || !canSave}>
          {saving ? t.common.loading : t.common.save}
        </button>
      </div>
    </Modal>
  );
}
