import { pageContent } from '../pageContent';
import { useLang } from '../LangContext';

export default function Privacy() {
  const { lang } = useLang();
  const t = pageContent[lang].privacy;

  return (
    <section className="mk-section mk-page">
      <div className="mk-container mk-page-narrow">
        <h1 className="mk-page-title">{t.title}</h1>
        <p className="mk-page-updated">{t.updated}</p>
        <div className="mk-page-callout mk-legal-disclaimer">
          <h3>{t.disclaimerTitle}</h3>
          <p>{t.disclaimerBody}</p>
        </div>
        <p className="mk-page-intro">{t.intro}</p>
        {t.sections.map((s) => (
          <div className="mk-legal-block" key={s.heading}>
            <h3>{s.heading}</h3>
            <p>{s.body}</p>
            {s.list && (
              <ul className="mk-legal-list">
                {s.list.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
