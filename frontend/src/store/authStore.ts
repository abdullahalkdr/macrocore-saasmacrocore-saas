import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthUser {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  company_id: string;
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
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      company: null,
      setAuth: (token, user, company) => set({ token, user, company: company ?? null }),
      logout: () => set({ token: null, user: null, company: null }),
    }),
    { name: 'macrocore-auth' }
  )
);
