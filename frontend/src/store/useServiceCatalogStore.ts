import { create } from 'zustand';
import { get, post, put, del, ApiError } from '../api/client';

export interface ServiceCategory {
  id: string;
  name: string;
  name_en: string | null;
  description: string | null;
  description_en: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceRequestType {
  id: string;
  category_id: string | null;
  name: string;
  name_en: string | null;
  description: string | null;
  description_en: string | null;
  is_hr_sensitive: boolean;
  created_at: string;
  updated_at: string;
}

export type CustomFieldType = 'text' | 'textarea' | 'number' | 'dropdown';

export interface ServiceCustomField {
  id: string;
  request_type_id: string;
  field_key: string;
  field_label: string;
  field_label_en: string | null;
  field_type: CustomFieldType;
  is_required: boolean;
  created_at: string;
  updated_at: string;
}

export interface ServiceCategoryInput {
  name: string;
  name_en?: string | null;
  description?: string | null;
  description_en?: string | null;
  icon?: string | null;
}

export interface ServiceRequestTypeInput {
  category_id?: string | null;
  name: string;
  name_en?: string | null;
  description?: string | null;
  description_en?: string | null;
  is_hr_sensitive?: boolean;
}

export interface ServiceCustomFieldInput {
  request_type_id: string;
  field_key: string;
  field_label: string;
  field_label_en?: string | null;
  field_type?: CustomFieldType;
  is_required?: boolean;
}

interface ServiceCatalogState {
  categories: ServiceCategory[];
  requestTypes: ServiceRequestType[];
  customFields: ServiceCustomField[];
  loading: boolean;
  error: string | null;

  // ITSM pivot Step 3: the portal (category -> request type -> custom fields)
  // and the settings CRUD page both need the same three lists, so this is
  // fetched once as a flat, unfiltered set per resource (small scale — a
  // kiosk-tenant's catalog is a handful of rows, not worth paginating or
  // caching per-parent-id) and filtered client-side wherever a component
  // needs "request types under this category" or "fields for this request
  // type". fetchAll() is the one callers actually use on mount.
  fetchCategories: () => Promise<void>;
  fetchRequestTypes: () => Promise<void>;
  fetchCustomFields: () => Promise<void>;
  fetchAll: () => Promise<void>;

  createCategory: (data: ServiceCategoryInput) => Promise<void>;
  updateCategory: (id: string, data: Partial<ServiceCategoryInput>) => Promise<void>;
  removeCategory: (id: string) => Promise<void>;

  createRequestType: (data: ServiceRequestTypeInput) => Promise<void>;
  updateRequestType: (id: string, data: Partial<ServiceRequestTypeInput> & { category_id?: string | null }) => Promise<void>;
  removeRequestType: (id: string) => Promise<void>;

  createCustomField: (data: ServiceCustomFieldInput) => Promise<void>;
  updateCustomField: (id: string, data: Partial<ServiceCustomFieldInput>) => Promise<void>;
  removeCustomField: (id: string) => Promise<void>;
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Server state, no persist — same reasoning as useTicketCategoriesStore/useSLAStore
// (this data goes stale the moment another tab/user edits it). create/update/remove
// don't catch their own errors — the caller's own try/catch surfaces an inline error
// banner (see ServiceCatalogSettingsPage / SupportTicketsPage's request-form handlers).
export const useServiceCatalogStore = create<ServiceCatalogState>()((set, getStore) => ({
  categories: [],
  requestTypes: [],
  customFields: [],
  loading: false,
  error: null,

  fetchCategories: async () => {
    try {
      const r = await get<{ categories: ServiceCategory[] }>('/service-categories');
      set({ categories: r.categories });
    } catch (err) {
      set({ error: errMsg(err, 'Failed to load service categories') });
    }
  },
  fetchRequestTypes: async () => {
    try {
      const r = await get<{ requestTypes: ServiceRequestType[] }>('/service-request-types');
      set({ requestTypes: r.requestTypes });
    } catch (err) {
      set({ error: errMsg(err, 'Failed to load request types') });
    }
  },
  fetchCustomFields: async () => {
    try {
      const r = await get<{ fields: ServiceCustomField[] }>('/service-custom-fields');
      set({ customFields: r.fields });
    } catch (err) {
      set({ error: errMsg(err, 'Failed to load custom fields') });
    }
  },
  fetchAll: async () => {
    set({ loading: true, error: null });
    const store = getStore();
    await Promise.all([store.fetchCategories(), store.fetchRequestTypes(), store.fetchCustomFields()]);
    set({ loading: false });
  },

  createCategory: async (data) => {
    await post('/service-categories', data);
    await getStore().fetchCategories();
  },
  updateCategory: async (id, data) => {
    await put(`/service-categories/${id}`, data);
    await getStore().fetchCategories();
  },
  removeCategory: async (id) => {
    await del(`/service-categories/${id}`);
    // CASCADE on the backend (MIGRATION_047) — deleting a category also
    // deletes its request types and their custom fields, so refetch all
    // three lists, not just categories, or the UI would keep showing
    // now-deleted request types/fields until the next full page load.
    await Promise.all([getStore().fetchCategories(), getStore().fetchRequestTypes(), getStore().fetchCustomFields()]);
  },

  createRequestType: async (data) => {
    await post('/service-request-types', data);
    await getStore().fetchRequestTypes();
  },
  updateRequestType: async (id, data) => {
    await put(`/service-request-types/${id}`, data);
    await getStore().fetchRequestTypes();
  },
  removeRequestType: async (id) => {
    await del(`/service-request-types/${id}`);
    // Same cascade reasoning as removeCategory — its custom fields go too.
    await Promise.all([getStore().fetchRequestTypes(), getStore().fetchCustomFields()]);
  },

  createCustomField: async (data) => {
    await post('/service-custom-fields', data);
    await getStore().fetchCustomFields();
  },
  updateCustomField: async (id, data) => {
    await put(`/service-custom-fields/${id}`, data);
    await getStore().fetchCustomFields();
  },
  removeCustomField: async (id) => {
    await del(`/service-custom-fields/${id}`);
    await getStore().fetchCustomFields();
  },
}));
