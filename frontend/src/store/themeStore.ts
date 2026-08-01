import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark';

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'light',
      toggle: () => set({ theme: get().theme === 'light' ? 'dark' : 'light' }),
      setTheme: (theme) => set({ theme }),
    }),
    { name: 'macrocore-theme' }
  )
);
