import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Lang } from './content';

interface LangContextValue {
  lang: Lang;
  isRTL: boolean;
  toggle: () => void;
}

const LangContext = createContext<LangContextValue | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>('ar');
  const isRTL = lang === 'ar';

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
  }, [lang, isRTL]);

  function toggle() {
    setLang((l) => (l === 'ar' ? 'en' : 'ar'));
  }

  return <LangContext.Provider value={{ lang, isRTL, toggle }}>{children}</LangContext.Provider>;
}

export function useLang() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useLang must be used within LangProvider');
  return ctx;
}
