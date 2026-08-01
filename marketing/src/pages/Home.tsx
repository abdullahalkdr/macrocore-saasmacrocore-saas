import { Fragment, useState } from 'react';
import { content, APP_URL, type FeatureCategory } from '../content';
import { useLang } from '../LangContext';
import Mockup, { DashboardMockup } from '../Mockup';

const ICONS = ['🧾', '📦', '👥', '📄', '📊', '🏢'];
const VERTICAL_ICONS = ['🌭', '☕', '👕', '🏠'];
const ICON_TONES = ['tone-amber', 'tone-blue', 'tone-green', 'tone-purple', 'tone-amber', 'tone-blue'];

// For a given tier column, returns only what's new/upgraded vs. the tier right below it
// (or, for the cheapest tier, its full base list) — the "everything in X, plus:" pattern.
function getTierBullets(featureMatrix: FeatureCategory[], tierIndex: number): string[] {
  const bullets: string[] = [];
  for (const cat of featureMatrix) {
    for (const row of cat.rows) {
      const val = row.values[tierIndex];
      const prevVal = tierIndex > 0 ? row.values[tierIndex - 1] : undefined;
      if (typeof val === 'boolean') {
        if (val && (tierIndex === 0 || !prevVal)) bullets.push(row.label);
      } else if (typeof val === 'string' && val) {
        if (tierIndex === 0 || val !== prevVal) bullets.push(`${row.label}: ${val}`);
      }
    }
  }
  return bullets;
}

// Text + reveal-on-hover arrow used on primary CTA buttons (text nudges over, arrow fades in).
function ArrowLabel({ children }: { children: string }) {
  return (
    <span className="mk-btn-arrow-label">
      <span>{children}</span>
      <span className="mk-btn-arrow" aria-hidden="true">‹</span>
    </span>
  );
}

export default function Home() {
  const { lang, isRTL } = useLang();
  const t = content[lang];
  const [annual, setAnnual] = useState(false);
  const [addOnAnnual, setAddOnAnnual] = useState(false);
  const [featureView, setFeatureView] = useState<'summary' | 'detail'>('summary');
  const highlightedIndex = t.pricingTiers.findIndex((tier) => tier.highlighted);

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  }

  return (
    <>
      <section className="mk-hero">
        <div className="mk-container mk-hero-grid">
          <div className="mk-hero-copy">
            <h1>{t.hero.title}</h1>
            <p className="mk-hero-subtitle">{t.hero.subtitle}</p>
            <div className="mk-hero-actions">
              <a className="mk-btn mk-btn-primary mk-btn-lg mk-btn-arrow-hover" href={APP_URL}>
                <ArrowLabel>{t.hero.ctaPrimary}</ArrowLabel>
              </a>
              <button className="mk-btn mk-btn-ghost mk-btn-lg" onClick={() => scrollTo('features')}>
                {t.hero.ctaSecondary}
              </button>
            </div>
            <p className="mk-hero-trust">{t.hero.trust}</p>
          </div>
          <div className="mk-hero-visual">
            <DashboardMockup />
          </div>
        </div>
      </section>

      <section className="mk-stats">
        <div className="mk-container">
          <div className="mk-stats-grid">
            {t.stats.map((s) => (
              <div className="mk-stat" key={s.label}>
                <div className="mk-stat-value">{s.value}</div>
                <div className="mk-stat-label">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="mk-section">
        <div className="mk-container">
          <h2>{t.featuresTitle}</h2>
          <p className="mk-section-subtitle">{t.featuresSubtitle}</p>
          <div className="mk-grid mk-grid-3">
            {t.features.map((f, i) => (
              <div className="mk-card" key={f.title}>
                <div className={`mk-card-icon ${ICON_TONES[i]}`}>{ICONS[i]}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {t.deepDives.map((d, i) => (
        <section className={`mk-section mk-deepdive ${i % 2 === 1 ? 'mk-section-alt' : ''}`} key={d.title}>
          <div className="mk-container">
            <div className={`mk-deepdive-grid ${i % 2 === 1 ? 'mk-deepdive-reverse' : ''}`}>
              <div className="mk-deepdive-copy">
                <span className="mk-eyebrow">{d.eyebrow}</span>
                <h2>{d.title}</h2>
                <p>{d.desc}</p>
                <ul className="mk-check-list">
                  {d.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
              <div className="mk-deepdive-visual">
                <Mockup kind={d.mockup} />
              </div>
            </div>
          </div>
        </section>
      ))}

      <section id="verticals" className="mk-section mk-section-alt">
        <div className="mk-container">
          <h2>{t.verticalsTitle}</h2>
          <p className="mk-section-subtitle">{t.verticalsSubtitle}</p>
          <div className="mk-grid mk-grid-4">
            {t.verticals.map((v, i) => (
              <div className="mk-card mk-card-compact" key={v.title}>
                <div className="mk-card-icon">{VERTICAL_ICONS[i]}</div>
                <h3>{v.title}</h3>
                <p>{v.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="how" className="mk-section">
        <div className="mk-container">
          <h2>{t.howTitle}</h2>
          <p className="mk-section-subtitle">{t.howSubtitle}</p>
          <div className="mk-grid mk-grid-3">
            {t.steps.map((s, i) => (
              <div className="mk-step" key={s.title}>
                <div className="mk-step-num">{i + 1}</div>
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" className="mk-section mk-section-alt">
        <div className="mk-container">
          <h2>{t.pricingTitle}</h2>
          <p className="mk-section-subtitle">{t.pricingSubtitle}</p>

          <div className="mk-billing-toggle">
            <button className={!annual ? 'mk-billing-active' : ''} onClick={() => setAnnual(false)}>
              {t.billingMonthly}
            </button>
            <button className={annual ? 'mk-billing-active' : ''} onClick={() => setAnnual(true)}>
              {t.billingAnnual}
            </button>
          </div>
          {annual && <p className="mk-annual-callout">{t.annualCallout}</p>}

          <div className="mk-pricing-grid mk-pricing-grid-4">
            {t.pricingTiers.map((tier) => (
              <div className={`mk-pricing-card ${tier.highlighted ? 'mk-pricing-highlighted' : ''}`} key={tier.name}>
                {tier.highlighted && <div className="mk-pricing-badge">{t.mostPopular}</div>}
                <h3>{tier.name}</h3>
                <p className="mk-pricing-desc">{tier.desc}</p>

                {tier.contactOnly ? (
                  <div className="mk-pricing-price mk-pricing-price-contact">{t.contactSales}</div>
                ) : (
                  <>
                    <div className="mk-pricing-price">
                      {annual && <span className="mk-pricing-strike">${tier.priceMonthlyUsd}</span>}
                      <span className="mk-pricing-amount">${annual ? tier.priceAnnualUsd : tier.priceMonthlyUsd}</span>
                      <span className="mk-pricing-period">/{t.perMonth}</span>
                    </div>
                    <div className="mk-pricing-kwd">
                      ≈ {annual ? tier.priceAnnualKwd : tier.priceMonthlyKwd} {isRTL ? 'د.ك' : 'KD'}
                    </div>
                  </>
                )}

                <a
                  className={`mk-btn ${tier.highlighted ? 'mk-btn-primary' : 'mk-btn-ghost'} mk-pricing-cta mk-btn-arrow-hover`}
                  href={tier.contactOnly ? '/contact' : APP_URL}
                >
                  <ArrowLabel>{tier.cta}</ArrowLabel>
                </a>
              </div>
            ))}
          </div>
          <p className="mk-pricing-note">{t.pricingNote}</p>

          <h3 className="mk-matrix-title">{t.featureMatrixTitle}</h3>
          <div className="mk-billing-toggle mk-feature-tabs">
            <button className={featureView === 'detail' ? 'mk-billing-active' : ''} onClick={() => setFeatureView('detail')}>
              {t.featureViewDetailLabel}
            </button>
            <button className={featureView === 'summary' ? 'mk-billing-active' : ''} onClick={() => setFeatureView('summary')}>
              {t.featureViewSummaryLabel}
            </button>
          </div>

          {featureView === 'summary' ? (
            <div className="mk-summary-grid">
              {t.pricingTiers.map((tier, i) => (
                <div className={`mk-summary-col ${i === highlightedIndex ? 'mk-summary-col-highlight' : ''}`} key={tier.name}>
                  {i === highlightedIndex && <div className="mk-pricing-badge">{t.mostPopular}</div>}
                  <h4>{tier.name}</h4>
                  {i > 0 && (
                    <p className="mk-summary-plus">
                      {t.summaryPlusTemplate.replace('{tier}', t.pricingTiers[i - 1].name)}
                    </p>
                  )}
                  <ul className="mk-summary-list">
                    {getTierBullets(t.featureMatrix, i).map((b) => (
                      <li key={b}>
                        <span className="mk-matrix-check">✓</span>
                        {b}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <div className="mk-matrix-wrap">
              <table className="mk-matrix">
                <thead>
                  <tr>
                    <th></th>
                    {t.pricingTiers.map((tier, i) => (
                      <th key={tier.name} className={i === highlightedIndex ? 'mk-matrix-col-highlight' : ''}>
                        {tier.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.featureMatrix.map((cat) => (
                    <Fragment key={cat.name}>
                      <tr className="mk-matrix-cat-row">
                        <td colSpan={5}>{cat.name}</td>
                      </tr>
                      {cat.rows.map((row) => (
                        <tr key={row.label}>
                          <td className="mk-matrix-label">{row.label}</td>
                          {row.values.map((v, i) => {
                            const colHighlight = i === highlightedIndex ? 'mk-matrix-col-highlight' : '';
                            const isUnlimited = typeof v === 'string' && /غير محدود|unlimited/i.test(v);
                            return (
                              <td key={i} className={`mk-matrix-cell ${colHighlight}`}>
                                {typeof v === 'string' ? (
                                  <span className={`mk-matrix-badge ${isUnlimited && i === highlightedIndex ? 'mk-matrix-badge-amber' : ''}`}>
                                    {v}
                                  </span>
                                ) : v ? (
                                  <span className="mk-matrix-check">✓</span>
                                ) : (
                                  <span className="mk-matrix-cross">✗</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mk-addons">
            <div className="mk-addons-head">
              <h3 className="mk-addons-title">{t.addOnsTitle}</h3>
              <p className="mk-section-subtitle">{t.addOnsSubtitle}</p>
              <div className="mk-billing-toggle mk-billing-toggle-sm">
                <button className={!addOnAnnual ? 'mk-billing-active' : ''} onClick={() => setAddOnAnnual(false)}>
                  {t.billingMonthly}
                </button>
                <button className={addOnAnnual ? 'mk-billing-active' : ''} onClick={() => setAddOnAnnual(true)}>
                  {t.billingAnnual}
                </button>
              </div>
            </div>
            <div className="mk-grid mk-grid-3">
              {t.addOns.map((a) => (
                <div className="mk-card mk-addon-card" key={a.name}>
                  <h3>{a.name}</h3>
                  <p>{a.desc}</p>
                  <div className="mk-pricing-price mk-addon-price">
                    <span className="mk-pricing-amount">${addOnAnnual ? a.priceAnnualUsd : a.priceMonthlyUsd}</span>
                    <span className="mk-pricing-period">/{addOnAnnual ? t.addOnBilledAnnual : t.addOnBilledMonthly}</span>
                  </div>
                  <div className="mk-pricing-kwd">
                    ≈ {addOnAnnual ? a.priceAnnualKwd : a.priceMonthlyKwd} {isRTL ? 'د.ك' : 'KD'}
                  </div>
                  <a className="mk-btn mk-btn-primary mk-addon-cta mk-btn-arrow-hover" href={APP_URL}>
                    <ArrowLabel>{t.pricingTiers[0].cta}</ArrowLabel>
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container">
          <h2>{t.supportTitle}</h2>
          <p className="mk-section-subtitle">{t.supportSubtitle}</p>
          <div className="mk-grid mk-grid-3">
            {t.supportCards.map((c) => (
              <div className="mk-card mk-card-compact" key={c.title}>
                <h3>{c.title}</h3>
                <p>{c.desc}</p>
                <a className="mk-btn mk-btn-ghost mk-support-btn" href="mailto:hello@macrocore.io">
                  {c.button}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mk-cta-banner">
        <div className="mk-container mk-cta-banner-inner">
          <h2>{t.ctaBanner.title}</h2>
          <p>{t.ctaBanner.subtitle}</p>
          <a className="mk-btn mk-btn-primary mk-btn-lg mk-btn-arrow-hover" href={APP_URL}>
            <ArrowLabel>{t.ctaBanner.button}</ArrowLabel>
          </a>
        </div>
      </section>
    </>
  );
}
