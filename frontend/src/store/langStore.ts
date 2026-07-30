import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Lang = 'ar' | 'en';

interface LangState {
  lang: Lang;
  toggle: () => void;
  setLang: (lang: Lang) => void;
}

// Defaults to Arabic — this is a Kuwait-market product, same default CornLab uses.
export const useLangStore = create<LangState>()(
  persist(
    (set, get) => ({
      lang: 'ar',
      toggle: () => set({ lang: get().lang === 'ar' ? 'en' : 'ar' }),
      setLang: (lang) => set({ lang }),
    }),
    { name: 'macrocore-lang' }
  )
);

export const isRTL = (lang: Lang) => lang === 'ar';
