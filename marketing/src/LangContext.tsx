import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Lang } from './content';

interface LangContextValue {
  lang: Lang;
  isRTL: boolean;
  toggle: () => void;
  path: (subpath?: string) => string;
}

const LangContext = createContext<LangContextValue | null>(null);

// Language now lives in the URL (/ar/... or /en/...) instead of just React state — so
// macrocore.io/ar is a real, linkable, shareable, SEO-indexable page, not just a client-side
// toggle that resets to Arabic on every reload. See App.tsx for the route nesting under
// /:lang that makes this param always present.
export function LangProvider({ children }: { children: ReactNode }) {
  const { lang: langParam } = useParams<{ lang: string }>();
  const navigate = useNavigate();
  const lang: Lang = langParam === 'en' ? 'en' : 'ar';
  const isRTL = lang === 'ar';

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
  }, [lang, isRTL]);

  function toggle() {
    const next: Lang = lang === 'ar' ? 'en' : 'ar';
    const rest = window.location.pathname.replace(/^\/(ar|en)/, '') || '/';
    navigate(`/${next}${rest === '/' ? '' : rest}`);
  }

  // Builds an in-app link that keeps the current language — e.g. path('/about') -> '/ar/about'.
  function path(subpath = '') {
    return `/${lang}${subpath}`;
  }

  return <LangContext.Provider value={{ lang, isRTL, toggle, path }}>{children}</LangContext.Provider>;
}

export function useLang() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useLang must be used within LangProvider');
  return ctx;
}
