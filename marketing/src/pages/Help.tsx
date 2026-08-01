import { pageContent } from '../pageContent';
import { useLang } from '../LangContext';

export default function Help() {
  const { lang } = useLang();
  const t = pageContent[lang].help;

  return (
    <section className="mk-section mk-page">
      <div className="mk-container mk-page-narrow">
        <h1 className="mk-page-title">{t.title}</h1>
        <p className="mk-page-intro">{t.subtitle}</p>
        <div className="mk-grid mk-grid-3 mk-help-grid">
          {t.articles.map((a) => (
            <div className="mk-card" key={a.title}>
              <h3>{a.title}</h3>
              <p>{a.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
