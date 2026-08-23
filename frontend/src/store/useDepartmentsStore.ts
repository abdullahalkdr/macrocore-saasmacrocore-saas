import { create } from 'zustand';
import { get, post, put, del, ApiError } from '../api/client';

export interface Department {
  id: string;
  name: string;
  name_en: string;
  created_at: string;
  updated_at: string;
}

export interface DepartmentInput {
  name: string;
  name_en: string;
}

interface DepartmentsState {
  departments: Department[];
  loading: boolean;
  error: string | null;

  // MIGRATION_048 — dynamic, per-company corporate departments (HR / Operations /
  // IT / Marketing / Finance / Legal, etc.), seeded with 6 defaults per company
  // and freely renamed/added/deleted afterward from DepartmentsPage. Used by
  // EmployeesPage's department picker and read (via the employees join, or the
  // users list join for a linked login account) wherever a department needs to
  // show — the Support Tickets assignee picker in particular.
  fetchAll: () => Promise<void>;
  createDepartment: (data: DepartmentInput) => Promise<void>;
  updateDepartment: (id: string, data: Partial<DepartmentInput>) => Promise<void>;
  removeDepartment: (id: string) => Promise<void>;
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Server state, no persist — same reasoning as useServiceCatalogStore/useSLAStore.
export const useDepartmentsStore = create<DepartmentsState>()((set, getStore) => ({
  departments: [],
  loading: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true, error: null });
    try {
      const r = await get<{ departments: Department[] }>('/departments');
      set({ departments: r.departments });
    } catch (err) {
      set({ error: errMsg(err, 'Failed to load departments') });
    } finally {
      set({ loading: false });
    }
  },

  createDepartment: async (data) => {
    await post('/departments', data);
    await getStore().fetchAll();
  },
  updateDepartment: async (id, data) => {
    await put(`/departments/${id}`, data);
    await getStore().fetchAll();
  },
  removeDepartment: async (id) => {
    await del(`/departments/${id}`);
    await getStore().fetchAll();
  },
}));
