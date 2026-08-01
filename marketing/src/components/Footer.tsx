import { Link, useNavigate } from 'react-router-dom';
import { content } from '../content';
import { useLang } from '../LangContext';

export default function Footer() {
  const { lang, path } = useLang();
  const t = content[lang];
  const navigate = useNavigate();

  function goToSection(id: string) {
    navigate(path());
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 50);
  }

  const productLinks: { label: string; action: () => void }[] = [
    { label: t.footer.productLinks[0], action: () => goToSection('features') },
    { label: t.footer.productLinks[1], action: () => goToSection('verticals') },
    { label: t.footer.productLinks[2], action: () => goToSection('pricing') },
  ];

  const resourceLinks: { label: string; to?: string; action?: () => void }[] = [
    { label: t.footer.resourceLinks[0], to: path('/help') },
    { label: t.footer.resourceLinks[1], action: () => goToSection('how') },
    { label: t.footer.resourceLinks[2], to: path('/faq') },
  ];

  const companyLinks = [
    { label: t.footer.companyLinks[0], to: path('/about') },
    { label: t.footer.companyLinks[1], to: path('/contact') },
    { label: t.footer.companyLinks[2], to: path('/terms') },
    { label: t.footer.companyLinks[3], to: path('/privacy') },
  ];

  return (
    <footer className="mk-footer">
      <div className="mk-container mk-footer-inner">
        <div>
          <Link to={path()} className="mk-logo mk-logo-footer mk-logo-link">
            macrocore
          </Link>
          <p>{t.footer.tagline}</p>
        </div>
        <div>
          <h4>{t.footer.product}</h4>
          {productLinks.map((l) => (
            <button key={l.label} onClick={l.action}>
              {l.label}
            </button>
          ))}
        </div>
        <div>
          <h4>{t.footer.resources}</h4>
          {resourceLinks.map((l) =>
            l.to ? (
              <Link to={l.to} key={l.label}>
                {l.label}
              </Link>
            ) : (
              <button key={l.label} onClick={l.action}>
                {l.label}
              </button>
            )
          )}
        </div>
        <div>
          <h4>{t.footer.company}</h4>
          {companyLinks.map((l) => (
            <Link to={l.to} key={l.label}>
              {l.label}
            </Link>
          ))}
        </div>
      </div>
      <div className="mk-container mk-footer-bottom">
        © {new Date().getFullYear()} macrocore. {t.footer.rights}
      </div>
    </footer>
  );
}
