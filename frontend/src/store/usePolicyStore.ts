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
  // Policy Gate pilot (MIGRATION_074/075) — permission_keys currently gated behind THIS
  // policy (today, at most one: 'view_audit_log' — see PILOT_GATED_PERMISSION_KEYS on
  // the backend). Always present — getOne() on the backend always returns it, even as
  // an empty array for a policy that gates nothing.
  permission_gates: string[];
}

// Shape returned by GET /permissions/my-pending-grants — one row per permission this
// employee has been assigned that's still waiting on their own acknowledgment of the
// gating policy. Intentionally carries the full policy content (not just its id/name)
// so PermissionGrantAcknowledgeModal never needs a second round-trip to show it.
export interface PendingPermissionGrant {
  id: string;
  permission_key: string;
  policy_id: string;
  name: string;
  name_en: string | null;
  content: string;
  content_en: string | null;
  version: number;
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

  // Policy Gate pilot (MIGRATION_074/075) — Step 3. Deliberately separate from
  // `pending`/`pendingLoading` above (the general P&P mandatory-acknowledgment queue):
  // this pilot's pending grants never block anything, and are keyed by permission, not
  // by policy — one policy can back many pending grants for the same employee if it's
  // ever linked to more than one key in the future.
  pendingGrants: PendingPermissionGrant[];
  pendingGrantsLoading: boolean;

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
  // Policy Gate pilot (MIGRATION_074/075) — Step 3.
  fetchPendingGrants: () => Promise<void>;
  acknowledgePendingGrant: (id: string) => Promise<void>;
  setPermissionGate: (policyId: string, permissionKey: string, enabled: boolean) => Promise<void>;
  // Cross-user isolation (2026-09) — see fetchPendingGrants' own comment. Called from
  // authStore.ts on logout/setAuth, not from within this file.
  resetPendingGrants: () => void;
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Module-level, not store state — deliberately outside the zustand store so bumping it
// never itself triggers a re-render (only the set() calls that check it do). See
// fetchPendingGrants'/resetPendingGrants' comments for the full race it closes.
let pendingGrantsEpoch = 0;

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
  pendingGrants: [],
  pendingGrantsLoading: false,

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
        policy: Omit<PolicyDetails, 'linked_roles' | 'acknowledgment_summary' | 'permission_gates'>;
        linked_roles: PolicyRole[];
        acknowledgment_summary: PolicyDetails['acknowledgment_summary'];
        permission_gates?: string[];
      }>(`/policies/${id}`);
      const details: PolicyDetails = {
        ...r.policy,
        linked_roles: r.linked_roles,
        acknowledgment_summary: r.acknowledgment_summary,
        permission_gates: r.permission_gates ?? [],
      };
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

  // Policy Gate pilot (MIGRATION_074/075) — Step 3.
  //
  // BUGFIX (2026-09, first pass) — cross-user stale content: this store is a
  // module-level singleton, not reset on login/logout. If user A had pending grants
  // loaded and the browser then authenticates as user B in the same tab (logout/login
  // without a full page reload), the OLD fetchPendingGrants left A's pendingGrants
  // array sitting in state until B's own fetch resolved — meaning A's policy content
  // (name/content/etc.) could render on B's screen for the gap between ProfileSection
  // mounting and this request completing. Partially fixed by clearing pendingGrants to
  // [] the instant a fetch starts (not just on success), and clearing it again on
  // failure too. Callers (ProfileSection) must render off pendingGrantsLoading, not
  // just pendingGrants.length, so the empty array this sets synchronously is never
  // mistaken for "confirmed: no pending grants" while the real fetch is still in flight.
  //
  // BUGFIX (2026-09, second pass) — that first pass was still incomplete in two ways:
  //
  //   1. It only cleared state from INSIDE fetchPendingGrants, i.e. only once
  //      ProfileSection's mount effect actually calls it. Between A logging out and B's
  //      ProfileSection first render (before that effect even runs), the singleton
  //      store still held A's data — a real, renderable frame of A's content on B's
  //      screen, not just a race. There is no way to close that gap from inside this
  //      function; it has to be closed at the moment identity actually changes, which
  //      happens in authStore, not here. See resetPendingGrants() below and its two
  //      call sites in authStore.ts's logout()/setAuth() — those run synchronously the
  //      instant the old session ends or a new one starts, before React re-renders
  //      anything, which is the only place this can be closed for good.
  //
  //   2. A slow request started under A could still resolve AFTER B's session is
  //      already active and write A's response into what is now B's state — clearing
  //      pendingGrants on logout doesn't stop an already-in-flight request started
  //      before that point from landing afterwards. Fixed with a module-level epoch
  //      counter: every call to fetchPendingGrants, and every call to
  //      resetPendingGrants (i.e. every identity change), bumps it. A response is only
  //      applied if the epoch captured when THIS request started still matches the
  //      current one when it resolves — otherwise a newer request or an identity change
  //      already happened, and the stale response is silently dropped.
  fetchPendingGrants: async () => {
    const myEpoch = ++pendingGrantsEpoch;
    set({ pendingGrants: [], pendingGrantsLoading: true });
    try {
      const r = await get<{ pending: PendingPermissionGrant[] }>('/permissions/my-pending-grants');
      if (myEpoch !== pendingGrantsEpoch) return; // a newer fetch or an identity change (logout/login) already superseded this request
      set({ pendingGrants: r.pending, pendingGrantsLoading: false });
    } catch {
      if (myEpoch !== pendingGrantsEpoch) return;
      // Non-fatal, same instinct as fetchPendingAcknowledgments above — a failed
      // background check on every profile-page load shouldn't surface as an error
      // banner. pendingGrants stays [] (already cleared above) rather than surfacing
      // whatever the previous fetch (possibly a different user's) had loaded.
      set({ pendingGrants: [], pendingGrantsLoading: false });
    }
  },

  // Called from authStore.ts's logout()/setAuth() — the two moments the authenticated
  // identity in this tab actually changes — so a previous user's pending-grant state
  // (and any request still in flight for it) can never survive into the next session.
  // Bumping the epoch here, not just clearing state, is what makes fetchPendingGrants'
  // in-flight guard above work across this exact boundary.
  resetPendingGrants: () => {
    pendingGrantsEpoch++;
    set({ pendingGrants: [], pendingGrantsLoading: false });
  },

  acknowledgePendingGrant: async (id) => {
    await post(`/permissions/my-pending-grants/${id}/acknowledge`, {});
    // Drop it from the local list immediately, same instinct as acknowledgePolicy above
    // — the modal closes right after this resolves, so ProfileSection's list should
    // already reflect the acknowledgment without waiting on a refetch round-trip.
    set((s) => ({ pendingGrants: s.pendingGrants.filter((g) => g.id !== id) }));
  },

  setPermissionGate: async (policyId, permissionKey, enabled) => {
    await post(`/policies/${policyId}/permission-gate`, { permission_key: permissionKey, enabled });
    if (getStore().selected?.id === policyId) await getStore().getPolicyDetails(policyId);
  },
}));
