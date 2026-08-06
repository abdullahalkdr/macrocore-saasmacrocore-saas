import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthUser {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  company_id: string;
  email_verified?: boolean;
}

export interface AuthCompany {
  id: string;
  name: string;
  plan: string;
  trial_end_date?: string;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  company: AuthCompany | null;
  setAuth: (token: string, user: AuthUser, company?: AuthCompany | null) => void;
  updateUser: (patch: Partial<AuthUser>) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      company: null,
      setAuth: (token, user, company) => set({ token, user, company: company ?? null }),
      // Local-only patch (e.g. flipping email_verified to true right after the user
      // completes verification) — doesn't touch the server, just keeps the cached user
      // object in sync so the UI doesn't need a re-login to reflect it.
      updateUser: (patch) => set((s) => (s.user ? { user: { ...s.user, ...patch } } : {})),
      logout: () => set({ token: null, user: null, company: null }),
    }),
    { name: 'macrocore-auth' }
  )
);
