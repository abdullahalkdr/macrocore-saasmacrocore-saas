import { create } from 'zustand';
import { get as apiGet } from '../api/client';

// MIGRATION_054 — effective permission set for the CURRENT user only (job-role layer +
// individual user_permissions layer, already merged server-side — see
// backend/src/utils/permissions.ts's effectivePermissions()). Server state, no persist —
// same reasoning as useDepartmentsStore: it's cheap to refetch and must never go stale
// across a permissions change made by an admin in another tab/session.
interface PermissionsState {
  permissionKeys: string[];
  loaded: boolean;
  fetchMyPermissions: () => Promise<void>;
  reset: () => void;
}

export const usePermissionsStore = create<PermissionsState>()((set) => ({
  permissionKeys: [],
  loaded: false,
  fetchMyPermissions: async () => {
    try {
      const r = await apiGet<{ permission_keys: string[] }>('/permissions/my-permissions');
      set({ permissionKeys: r.permission_keys, loaded: true });
    } catch {
      // Fails closed: an empty set only ever WIDENS what's visible via the permission
      // override (see Layout.tsx's visibleGroups) on top of normal role gating, it never
      // hides anything a role already grants — so a failed fetch here is safe to ignore.
      set({ permissionKeys: [], loaded: true });
    }
  },
  // Called from authStore.logout() indirectly (Layout.tsx unmounts on logout, and the
  // next login re-fetches) — exposed mainly so a future direct call site doesn't need to
  // reach into the store's internals.
  reset: () => set({ permissionKeys: [], loaded: false }),
}));

// Component-friendly hook — `useHasPermission('manage_payroll')` instead of manually
// selecting and calling `.includes()` at every call site.
export function useHasPermission(key: string): boolean {
  return usePermissionsStore((s) => s.permissionKeys.includes(key));
}
