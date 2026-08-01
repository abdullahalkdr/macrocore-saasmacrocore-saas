import { Link, useNavigate } from 'react-router-dom';
import { content, APP_URL } from '../content';
import { useLang } from '../LangContext';

export default function Header() {
  const { lang, isRTL, toggle, path } = useLang();
  const t = content[lang];
  const navigate = useNavigate();

  function goToSection(id: string) {
    navigate(path());
    // Wait a tick for Home to mount before scrolling.
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 50);
  }

  return (
    <header className="mk-header">
      <div className="mk-container mk-header-inner">
        <Link to={path()} className="mk-logo mk-logo-link">
          macrocore
        </Link>
        <nav className="mk-nav">
          <button onClick={() => goToSection('features')}>{t.nav.features}</button>
          <button onClick={() => goToSection('verticals')}>{t.nav.verticals}</button>
          <button onClick={() => goToSection('how')}>{t.nav.how}</button>
          <button onClick={() => goToSection('pricing')}>{t.nav.pricing}</button>
        </nav>
        <div className="mk-header-actions">
          <button className="mk-lang-toggle" onClick={toggle}>
            {isRTL ? 'English' : 'العربية'}
          </button>
          <a className="mk-btn mk-btn-ghost" href={APP_URL}>
            {t.nav.login}
          </a>
          <a className="mk-btn mk-btn-primary" href={APP_URL}>
            {t.nav.cta}
          </a>
        </div>
      </div>
    </header>
  );
}
