import { create } from 'zustand';
import { get, post, patch, ApiError } from '../api/client';

export type PolicyStatus = 'draft' | 'in_review' | 'approved' | 'archived';
// Kept in sync with the CHECK constraint on policies.module_linked — the first 5 from
// MIGRATION_044, the rest (global/standard categories + 'other') from MIGRATION_045.
export type SystemModule =
  | 'pos_shifts'
  | 'expenses_waste'
  | 'inventory_supply_chain'
  | 'hr_payroll'
  | 'reports'
  | 'health_safety'
  | 'data_privacy'
  | 'customer_service'
  | 'code_of_conduct'
  | 'other';
export type PolicyRole = 'admin' | 'manager' | 'employee';

export const POLICY_STATUSES: PolicyStatus[] = ['draft', 'in_review', 'approved', 'archived'];
export const POLICY_ROLES: PolicyRole[] = ['admin', 'manager', 'employee'];
export const SYSTEM_MODULES: SystemModule[] = [
  'pos_shifts',
  'expenses_waste',
  'inventory_supply_chain',
  'hr_payroll',
  'reports',
  'health_safety',
  'data_privacy',
  'customer_service',
  'code_of_conduct',
  'other',
];

export interface Policy {
  id: string;
  company_id: string;
  name: string;
  name_en: string | null;
  status: PolicyStatus;
  module_linked: SystemModule | null;
  version: number;
  created_by: string | null;
  reviewed_by: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PolicyDetails extends Policy {
  content: string;
  content_en: string | null;
  linked_roles: PolicyRole[];
  acknowledgment_summary: { total_acknowledged: number; last_acknowledged_at: string | null };
}

// Shape returned by GET /policies/pending-acknowledgment — deliberately narrower than
// Policy (no status/version-tracking fields the AcknowledgmentModal has no use for).
export interface PendingPolicy {
  id: string;
  name: string;
  name_en: string | null;
  content: string;
  content_en: string | null;
  version: number;
}

interface CreatePolicyInput {
  name: string;
  name_en?: string;
  content: string;
  content_en?: string;
  module_linked?: SystemModule | null;
}

interface PolicyState {
  policies: Policy[];
  loading: boolean;
  error: string | null;

  selected: PolicyDetails | null;
  selectedLoading: boolean;

  pending: PendingPolicy[];
  pendingLoading: boolean;

  fetchPolicies: (filters?: { status?: PolicyStatus; module_linked?: SystemModule }) => Promise<void>;
  getPolicyDetails: (id: string) => Promise<PolicyDetails | null>;
  createPolicy: (data: CreatePolicyInput) => Promise<Policy>;
  updateStatus: (id: string, status: PolicyStatus) => Promise<void>;
  // Convenience wrapper over updateStatus pinned to 'approved' — same endpoint, just
  // named to match the Dashboard's single-purpose "Approve" button.
  approvePolicy: (id: string) => Promise<void>;
  setRoles: (id: string, roles: PolicyRole[]) => Promise<void>;
  fetchPendingAcknowledgments: () => Promise<void>;
  acknowledgePolicy: (id: string, deviceInfo?: string) => Promise<{ already_acknowledged: boolean }>;
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// No persist middleware — deliberately. `policies`/`pending` are server state that
// goes stale the moment another user (or another tab) edits them; every other
// server-data store in this app (useSLAStore, usePerformanceStore) is runtime-only
// for the same reason. Only session/preference stores (authStore, langStore,
// themeStore) persist to localStorage.
export const usePolicyStore = create<PolicyState>()((set, getStore) => ({
  policies: [],
  loading: false,
  error: null,
  selected: null,
  selectedLoading: false,
  pending: [],
  pendingLoading: false,

  fetchPolicies: async (filters) => {
    set({ loading: true, error: null });
    try {
      const qs = new URLSearchParams();
      if (filters?.status) qs.set('status', filters.status);
      if (filters?.module_linked) qs.set('module_linked', filters.module_linked);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const r = await get<{ policies: Policy[] }>(`/policies${suffix}`);
      set({ policies: r.policies, loading: false });
    } catch (err) {
      set({ error: errMsg(err, 'Failed to load policies'), loading: false });
    }
  },

  getPolicyDetails: async (id) => {
    set({ selectedLoading: true });
    try {
      const r = await get<{
        policy: Omit<PolicyDetails, 'linked_roles' | 'acknowledgment_summary'>;
        linked_roles: PolicyRole[];
        acknowledgment_summary: PolicyDetails['acknowledgment_summary'];
      }>(`/policies/${id}`);
      const details: PolicyDetails = { ...r.policy, linked_roles: r.linked_roles, acknowledgment_summary: r.acknowledgment_summary };
      set({ selected: details, selectedLoading: false });
      return details;
    } catch (err) {
      set({ selectedLoading: false, error: errMsg(err, 'Failed to load policy') });
      return null;
    }
  },

  createPolicy: async (data) => {
    const r = await post<{ policy: Policy }>('/policies', data);
    await getStore().fetchPolicies();
    return r.policy;
  },

  updateStatus: async (id, status) => {
    await patch(`/policies/${id}/status`, { status });
    await getStore().fetchPolicies();
    if (getStore().selected?.id === id) await getStore().getPolicyDetails(id);
  },

  approvePolicy: async (id) => {
    await getStore().updateStatus(id, 'approved');
  },

  setRoles: async (id, roles) => {
    await post(`/policies/${id}/roles`, { roles });
    if (getStore().selected?.id === id) await getStore().getPolicyDetails(id);
  },

  fetchPendingAcknowledgments: async () => {
    set({ pendingLoading: true });
    try {
      const r = await get<{ pending: PendingPolicy[] }>('/policies/pending-acknowledgment');
      set({ pending: r.pending, pendingLoading: false });
    } catch {
      // Non-fatal, same instinct as Layout's pending-leave-requests poll — a failed
      // background check on every page load shouldn't surface as an error banner.
      set({ pendingLoading: false });
    }
  },

  acknowledgePolicy: async (id, deviceInfo) => {
    const r = await post<{ already_acknowledged: boolean; acknowledgment?: { id: string; acknowledged_at: string } }>(
      `/policies/${id}/acknowledge`,
      deviceInfo ? { device_info: deviceInfo } : undefined
    );
    // Drop it from the local pending queue immediately rather than waiting on a
    // refetch — AcknowledgmentModal reads pending[0] and chains straight into the
    // next mandatory policy (or closes) off this same state update.
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
    return { already_acknowledged: r.already_acknowledged };
  },
}));
