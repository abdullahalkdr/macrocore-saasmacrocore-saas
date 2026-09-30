import { Link, useNavigate } from 'react-router-dom';
import { content, APP_URL } from '../content';
import { useLang } from '../LangContext';
import LogoMark from './LogoMark';
import { useTheme } from '../ThemeContext';

export default function Header() {
  const { lang, isRTL, toggle, path } = useLang();
  const t = content[lang];
  const { theme, toggle: toggleTheme } = useTheme();
  const themeLabel = isRTL
    ? theme === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن'
    : theme === 'dark' ? 'Light mode' : 'Dark mode';
  const navigate = useNavigate();

  function goToSection(id: string) {
    navigate(path());
    // Wait a tick for Home to mount before scrolling.
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 50);
  }

  return (
    <header className="mk-header">
      <div className="mk-container mk-header-inner">
        <Link to={path()} className="mk-logo mk-logo-link" aria-label="macrocore">
          <LogoMark />
          macrocore
        </Link>
        <nav className="mk-nav">
          <button onClick={() => goToSection('features')}>{t.nav.features}</button>
          <button onClick={() => goToSection('verticals')}>{t.nav.verticals}</button>
          <button onClick={() => goToSection('how')}>{t.nav.how}</button>
          <button onClick={() => goToSection('pricing')}>{t.nav.pricing}</button>
        </nav>
        <div className="mk-header-actions">
          <button
            className="mk-theme-toggle"
            onClick={toggleTheme}
            aria-label={themeLabel}
            title={themeLabel}
          >
            {theme === 'dark' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4.2" />
                <path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
              </svg>
            )}
          </button>
          <button className="mk-lang-toggle" onClick={toggle}>
            {isRTL ? 'English' : 'العربية'}
          </button>
          <a className="mk-btn mk-btn-ghost" href={APP_URL}>
            {t.nav.login}
          </a>
          {/* One label per signup intent across the page (same as the hero CTA). */}
          <a className="mk-btn mk-btn-primary" href={APP_URL}>
            {t.hero.ctaPrimary}
          </a>
        </div>
      </div>
    </header>
  );
}
