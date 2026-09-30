import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

// Light / dark theme for the marketing site.
// - Default: follow the device (prefers-color-scheme).
// - The header toggle pins a choice, stored in localStorage and applied as
//   <html data-theme="light|dark">. index.html applies the stored choice before first
//   paint so there is no flash of the wrong theme.
export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'mk-theme';

interface ThemeContextValue {
  theme: Theme; // the theme actually shown right now
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pinned, setPinned] = useState<Theme | null>(readStored);
  const [system, setSystem] = useState<Theme>(systemTheme);

  // Track device changes while no choice is pinned.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const theme: Theme = pinned ?? system;

  useEffect(() => {
    const root = document.documentElement;
    if (pinned) root.setAttribute('data-theme', pinned);
    else root.removeAttribute('data-theme');
    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((m) => m.setAttribute('content', theme === 'dark' ? '#141210' : '#fafaf9'));
  }, [pinned, theme]);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setPinned(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage unavailable: the choice still applies for this visit */
    }
  }

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
