import { create } from 'zustand';
import { get, post, put, patch, del, ApiError } from '../api/client';

export interface JobRole {
  id: string;
  department_id: string;
  name: string;
  name_en: string | null;
}

export interface Department {
  id: string;
  name: string;
  name_en: string;
  parent_department_id: string | null;
  manager_id: string | null;
  manager: { id: string; name: string } | null;
  cost_center_code: string | null;
  status: 'active' | 'inactive';
  employee_count: number;
  roles: JobRole[];
  children: Department[];
  created_at: string;
  updated_at: string;
}

export interface DepartmentInput {
  name: string;
  name_en: string;
  parent_department_id?: string | null;
  manager_id?: string | null;
  cost_center_code?: string | null;
  status?: 'active' | 'inactive';
}

interface DepartmentsState {
  // MIGRATION_049 — Enterprise "Corporate Departments": GET /departments now
  // returns a Parent -> Children tree (each node carrying its manager, a
  // direct employee_count, and its own job_roles). departmentTree is that
  // tree, straight from the API, for the Enterprise Departments page's
  // tree/table. departments is the SAME data flattened depth-first into a
  // flat list — kept so EmployeesPage's simple "pick any department" select
  // (and anything else that just wants every department, not the hierarchy)
  // didn't need to change when this store's shape grew a tree.
  departmentTree: Department[];
  departments: Department[];
  loading: boolean;
  error: string | null;

  fetchAll: () => Promise<void>;
  createDepartment: (data: DepartmentInput) => Promise<void>;
  updateDepartment: (id: string, data: Partial<DepartmentInput>) => Promise<void>;
  removeDepartment: (id: string) => Promise<void>;

  // job_roles (MIGRATION_049) — nested under a department. Every mutation
  // re-fetches the whole tree (fetchAll) rather than hand-patching nested
  // state, same convention usePerformanceStore's create/update/remove
  // actions use for okr_key_results/appraisal_form_questions.
  createRole: (departmentId: string, data: { name: string; name_en?: string }) => Promise<void>;
  updateRole: (id: string, data: { name?: string; name_en?: string }) => Promise<void>;
  removeRole: (id: string) => Promise<void>;
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function flattenTree(nodes: Department[]): Department[] {
  const out: Department[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.children && n.children.length > 0) out.push(...flattenTree(n.children));
  }
  return out;
}

// Server state, no persist — same reasoning as useServiceCatalogStore/useSLAStore.
export const useDepartmentsStore = create<DepartmentsState>()((set, getStore) => ({
  departmentTree: [],
  departments: [],
  loading: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true, error: null });
    try {
      const r = await get<{ departments: Department[] }>('/departments');
      set({ departmentTree: r.departments, departments: flattenTree(r.departments) });
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

  createRole: async (departmentId, data) => {
    await post(`/departments/${departmentId}/roles`, data);
    await getStore().fetchAll();
  },
  updateRole: async (id, data) => {
    await patch(`/departments/roles/${id}`, data);
    await getStore().fetchAll();
  },
  removeRole: async (id) => {
    await del(`/departments/roles/${id}`);
    await getStore().fetchAll();
  },
}));
