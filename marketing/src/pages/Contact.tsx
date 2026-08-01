import { FormEvent, useState } from 'react';
import { pageContent } from '../pageContent';
import { useLang } from '../LangContext';

const CONTACT_EMAIL = 'hello@macrocore.io';

export default function Contact() {
  const { lang } = useLang();
  const t = pageContent[lang];
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');

  // No backend endpoint wired up yet — this opens the visitor's own email client
  // pre-filled, so the form is functional today without needing a mail server.
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const subject = encodeURIComponent(`رسالة من ${name || 'زائر الموقع'} — macrocore.io`);
    const body = encodeURIComponent(`${message}\n\n—\n${name}\n${email}`);
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
  }

  return (
    <section className="mk-section mk-page">
      <div className="mk-container mk-page-narrow">
        <h1 className="mk-page-title">{t.contact.title}</h1>
        <p className="mk-page-intro">{t.contact.subtitle}</p>

        <form className="mk-contact-form" onSubmit={handleSubmit}>
          <div className="mk-field">
            <label>{t.contact.nameLabel}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="mk-field">
            <label>{t.contact.emailLabel}</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="mk-field">
            <label>{t.contact.messageLabel}</label>
            <textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} required />
          </div>
          <button className="mk-btn mk-btn-primary mk-btn-lg" type="submit">
            {t.contact.send}
          </button>
        </form>

        <div className="mk-page-callout">
          <h3>{t.contact.directTitle}</h3>
          <p>
            {t.contact.directDesc} <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </p>
        </div>
      </div>
    </section>
  );
}
