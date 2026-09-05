import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { usePolicyStore } from './usePolicyStore';

export interface AuthUser {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  company_id: string;
  email_verified?: boolean;
  // 2026-08-26 HR-visibility fix — a login-time snapshot from hrScope.ts
  // (backend/src/utils/hrScope.ts). UI hint only for Layout.tsx's sidebar
  // filtering; every real HR/Users endpoint re-checks independently on the
  // server regardless of what this says.
  hr_access_level?: 'full' | 'department' | 'direct_reports' | 'self';
  can_access_users?: boolean;
}

export interface AuthCompany {
  id: string;
  name: string;
  plan: string;
  trial_end_date?: string;
  // GLOBAL UNLOCK — mirrors company.controller.ts getMe()'s plan_gating_bypassed
  // (env.BYPASS_PLAN_GATING, dev/test only). Not part of the login response — this
  // is a login-time snapshot store, and the bypass flag is a live server runtime
  // setting, not a per-company attribute fixed at login. Layout.tsx's existing
  // /company/me poll pushes the current value in here via updateCompany() so any
  // page reading useAuthStore(s => s.company) can see it without its own fetch.
  plan_gating_bypassed?: boolean;
  // Business-type module gating (2026-08-26, requireInventoryEnabled.ts) — same
  // "not part of the login response, pushed live from /company/me" reasoning as
  // plan_gating_bypassed above: this can change any time from Company Settings >
  // Preferences while the tab is already open, so it isn't part of AuthUser's
  // login-time snapshot either.
  inventory_enabled?: boolean;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  company: AuthCompany | null;
  setAuth: (token: string, user: AuthUser, company?: AuthCompany | null) => void;
  updateUser: (patch: Partial<AuthUser>) => void;
  updateCompany: (patch: Partial<AuthCompany>) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      company: null,
      // Cross-user isolation (2026-09) — setAuth is the moment a NEW identity takes
      // over this tab (fresh login or registration; the only two call sites, per
      // LoginPage.tsx/RegisterPage.tsx). Any other store's per-user cache (today, just
      // usePolicyStore's pending-grant state — see its own comment for the full race
      // this closes) must be wiped synchronously here, before this set() even commits,
      // so the very first render under the new identity can never read a previous
      // user's data and no response from a request that started under the old identity
      // can land afterwards.
      setAuth: (token, user, company) => {
        usePolicyStore.getState().resetPendingGrants();
        set({ token, user, company: company ?? null });
      },
      // Local-only patch (e.g. flipping email_verified to true right after the user
      // completes verification) — doesn't touch the server, just keeps the cached user
      // object in sync so the UI doesn't need a re-login to reflect it.
      updateUser: (patch) => set((s) => (s.user ? { user: { ...s.user, ...patch } } : {})),
      // Same idea for company — see AuthCompany.plan_gating_bypassed above.
      updateCompany: (patch) => set((s) => (s.company ? { company: { ...s.company, ...patch } } : {})),
      // Cross-user isolation (2026-09) — same reasoning as setAuth above, for the other
      // half of the boundary: the moment THIS identity's session ends.
      logout: () => {
        usePolicyStore.getState().resetPendingGrants();
        set({ token: null, user: null, company: null });
      },
    }),
    { name: 'macrocore-auth' }
  )
);
