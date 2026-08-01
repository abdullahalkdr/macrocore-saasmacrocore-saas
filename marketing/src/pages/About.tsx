import { pageContent } from '../pageContent';
import { useLang } from '../LangContext';

export default function About() {
  const { lang } = useLang();
  const t = pageContent[lang];

  return (
    <section className="mk-section mk-page">
      <div className="mk-container mk-page-narrow">
        <h1 className="mk-page-title">{t.about.title}</h1>
        <p className="mk-page-intro">{t.about.intro}</p>
        {t.about.paragraphs.map((p) => (
          <p className="mk-page-p" key={p}>
            {p}
          </p>
        ))}
        <div className="mk-page-callout">
          <h3>{t.about.missionTitle}</h3>
          <p>{t.about.mission}</p>
        </div>
      </div>
    </section>
  );
}
