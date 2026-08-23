import { FormEvent, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { ApiError } from '../api/client';
import {
  useServiceCatalogStore,
  ServiceCategory,
  ServiceRequestType,
  ServiceCustomField,
  CustomFieldType,
} from '../store/useServiceCatalogStore';
import PageHeader from '../components/PageHeader';
import Tag from '../components/Tag';

const FIELD_TYPES: CustomFieldType[] = ['text', 'textarea', 'number', 'dropdown'];

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

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const [tab, setTab] = useState<'categories' | 'requestTypes' | 'customFields'>('categories');
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null); // a row id, or 'new'
  const [savedId, setSavedId] = useState<string | null>(null);

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
    if (!window.confirm(t.serviceCatalog.deleteCategoryConfirm)) return;
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
    name: string;
    name_en: string;
    is_hr_sensitive: boolean;
  }
  const EMPTY_REQUEST_TYPE: RequestTypeDraft = { category_id: '', name: '', name_en: '', is_hr_sensitive: false };
  const [rtDrafts, setRtDrafts] = useState<Record<string, RequestTypeDraft>>({});
  const [newRequestType, setNewRequestType] = useState<RequestTypeDraft>(EMPTY_REQUEST_TYPE);

  useEffect(() => {
    setRtDrafts((d) => {
      const next = { ...d };
      for (const rt of requestTypes) {
        next[rt.id] = { category_id: rt.category_id || '', name: rt.name, name_en: rt.name_en || '', is_hr_sensitive: rt.is_hr_sensitive };
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
    if (!window.confirm(t.serviceCatalog.deleteRequestTypeConfirm)) return;
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
    if (!window.confirm(t.serviceCatalog.deleteFieldConfirm)) return;
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
                          <button className="btn btn-secondary btn-sm" type="button" onClick={() => handleDeleteCategory(c.id)} disabled={savingId === c.id}>
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
                    <th>{t.serviceCatalog.nameLabel}</th>
                    <th>{t.serviceCatalog.nameEnLabel}</th>
                    <th>{t.serviceCatalog.hrSensitive}</th>
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
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn btn-primary btn-sm" type="button" onClick={() => handleSaveRequestType(rt.id)} disabled={savingId === rt.id}>
                            {savingId === rt.id ? t.common.loading : t.common.save}
                          </button>{' '}
                          {savedId === rt.id && <Tag color="green">{t.serviceCatalog.saved}</Tag>}{' '}
                          <button className="btn btn-secondary btn-sm" type="button" onClick={() => handleDeleteRequestType(rt.id)} disabled={savingId === rt.id}>
                            {t.common.delete}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {requestTypes.length === 0 && !loading && (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty-state">{t.serviceCatalog.requestTypesEmpty}</div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="hr" style={{ margin: '16px 0' }} />

            <form onSubmit={handleAddRequestType} className="form-row">
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
                              <button className="btn btn-secondary btn-sm" type="button" onClick={() => handleDeleteField(f.id)} disabled={savingId === f.id}>
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
    </div>
  );
}
