import { useState } from 'react';
import { pageContent } from '../pageContent';
import { useLang } from '../LangContext';

export default function Faq() {
  const { lang } = useLang();
  const t = pageContent[lang].faq;
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section className="mk-section mk-page">
      <div className="mk-container mk-page-narrow">
        <h1 className="mk-page-title">{t.title}</h1>
        <p className="mk-page-intro">{t.subtitle}</p>
        <div className="mk-faq-list">
          {t.items.map((item, i) => {
            const open = openIndex === i;
            return (
              <div className={`mk-faq-item ${open ? 'mk-faq-open' : ''}`} key={item.q}>
                <button className="mk-faq-question" onClick={() => setOpenIndex(open ? null : i)}>
                  <span>{item.q}</span>
                  <span className="mk-faq-toggle">{open ? '−' : '+'}</span>
                </button>
                {open && <p className="mk-faq-answer">{item.a}</p>}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
