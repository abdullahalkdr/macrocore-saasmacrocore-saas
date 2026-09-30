import { Fragment, useEffect, useState } from 'react';
import { content, APP_URL, type FeatureCategory } from '../content';
import { Link } from 'react-router-dom';
import { useLang } from '../LangContext';
import { useTheme } from '../ThemeContext';

// Real product screenshots live in /public/screens as `<name>-light.webp` and
// `<name>-dark.webp`. The one matching the current theme (device setting or the
// header toggle) is shown. Until a file exists the frame shows a dashed placeholder instead of a
// broken image (local development only; don't ship with placeholders).
// hero = inventory overview (all materials across locations); the inventory deep dive
// shows the batches screen, where FIFO dates and expiry live.
const DIVE_SHOTS: Record<string, string> = { inventory: 'batches', payroll: 'payroll', reports: 'reports' };

function Shot({ name, alt, eager = false }: { name: string; alt: string; eager?: boolean }) {
  const [missing, setMissing] = useState(false);
  const { theme } = useTheme(); // follows the header toggle, not only the device setting
  return (
    <div className="mk-shot">
      {missing ? (
        <div className="mk-shot-placeholder">screens/{name}-light.webp</div>
      ) : (
        <picture>
          <img
            src={`/screens/${name}-${theme}.webp`}
            alt={alt}
            width={1350}
            height={640}
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
            onError={() => setMissing(true)}
          />
        </picture>
      )}
    </div>
  );
}

// For a given tier column, returns only what's new/upgraded vs. the tier right below it
// (or, for the cheapest tier, its full base list): the "everything in X, plus:" pattern.
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

// Primary CTA label with a chevron that slides in on hover (desktop pointers only).
function ArrowLabel({ children }: { children: string }) {
  return (
    <span className="mk-btn-arrow-label">
      <span>{children}</span>
      <span className="mk-btn-arrow" aria-hidden="true">‹</span>
    </span>
  );
}

// Fades sections in once as they enter the viewport. No-op under reduced motion (CSS)
// and without JS (content is only hidden when <html> has the .mk-js class).
function useScrollReveal(key: string) {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('mk-js');
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]:not(.is-in)'));
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-in');
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: '0px 0px -80px 0px', threshold: 0.1 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [key]);
}

export default function Home() {
  const { lang, isRTL, path } = useLang();
  const t = content[lang];
  const [annual, setAnnual] = useState(false);
  const [addOnAnnual, setAddOnAnnual] = useState(false);
  const [featureView, setFeatureView] = useState<'summary' | 'detail'>('summary');
  const [compareOpen, setCompareOpen] = useState(false);
  const highlightedIndex = t.pricingTiers.findIndex((tier) => tier.highlighted);
  useScrollReveal(lang);

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  }

  return (
    <>
      {/* Hero: asymmetric split, copy + real dashboard screenshot */}
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
          </div>
          <div className="mk-hero-visual">
            <Shot name="overview" alt={t.hero.title} eager />
          </div>
        </div>
      </section>

      {/* Proof band: the founder statement + the four facts */}
      <section className="mk-proof" data-reveal>
        <div className="mk-container mk-proof-inner">
          <p className="mk-proof-quote">{t.hero.trust}</p>
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

      {/* Features: bento (4+2 / 2+4 / 3+3) */}
      <section id="features" className="mk-section">
        <div className="mk-container">
          <div className="mk-section-head" data-reveal>
            <h2>{t.featuresTitle}</h2>
            <p className="mk-section-subtitle">{t.featuresSubtitle}</p>
          </div>
          <div className="mk-bento" data-reveal>
            {t.features.map((f) => (
              <div className="mk-bento-cell" key={f.title}>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Deep dives: split, stacked-wide, flipped split (no three-in-a-row zigzag) */}
      {t.deepDives.map((d, i) => {
        const shot = <Shot name={DIVE_SHOTS[d.mockup] ?? d.mockup} alt={d.title} />;
        const bullets = (
          <ul className="mk-check-list">
            {d.bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        );
        if (i === 1) {
          return (
            <section className="mk-section mk-section-alt mk-dive-stack" key={d.title}>
              <div className="mk-container" data-reveal>
                <div className="mk-dive-stack-head">
                  <div className="mk-dive-copy">
                    <h2>{d.title}</h2>
                    <p>{d.desc}</p>
                  </div>
                  {bullets}
                </div>
                {shot}
              </div>
            </section>
          );
        }
        return (
          <section className="mk-section" key={d.title}>
            <div className={`mk-container mk-dive-split ${i === 2 ? 'mk-dive-flip' : ''}`} data-reveal>
              <div className="mk-dive-copy">
                <h2>{d.title}</h2>
                <p>{d.desc}</p>
                {bullets}
              </div>
              <div>{shot}</div>
            </div>
          </section>
        );
      })}

      {/* Verticals: sticky heading + 2x2 list */}
      <section id="verticals" className="mk-section mk-section-alt">
        <div className="mk-container mk-verticals">
          <div className="mk-section-head">
            <h2>{t.verticalsTitle}</h2>
            <p className="mk-section-subtitle">{t.verticalsSubtitle}</p>
          </div>
          <ul className="mk-vertical-list" data-reveal>
            {t.verticals.map((v) => (
              <li key={v.title}>
                <h3>{v.title}</h3>
                <p>{v.desc}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* How it works: ordered row */}
      <section id="how" className="mk-section">
        <div className="mk-container">
          <div className="mk-section-head" data-reveal>
            <h2>{t.howTitle}</h2>
            <p className="mk-section-subtitle">{t.howSubtitle}</p>
          </div>
          <ol className="mk-steps" data-reveal>
            {t.steps.map((s) => (
              <li key={s.title}>
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Pricing: plans visible, comparison + add-ons behind one disclosure */}
      <section id="pricing" className="mk-section mk-section-alt">
        <div className="mk-container">
          <div className="mk-section-head mk-section-head-center" data-reveal>
            <h2>{t.pricingTitle}</h2>
            <p className="mk-section-subtitle">{t.pricingSubtitle}</p>
          </div>

          <div className="mk-billing-toggle">
            <button className={!annual ? 'mk-billing-active' : ''} aria-pressed={!annual} onClick={() => setAnnual(false)}>
              {t.billingMonthly}
            </button>
            <button className={annual ? 'mk-billing-active' : ''} aria-pressed={annual} onClick={() => setAnnual(true)}>
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

          <button
            className="mk-compare-toggle"
            aria-expanded={compareOpen}
            aria-controls="mk-compare-panel"
            onClick={() => setCompareOpen((o) => !o)}
          >
            {t.featureMatrixTitle}
            <span className="mk-compare-chevron" aria-hidden="true">⌄</span>
          </button>

          {compareOpen && (
            <div id="mk-compare-panel" className="mk-compare-panel">
              <div className="mk-billing-toggle mk-feature-tabs">
                <button className={featureView === 'detail' ? 'mk-billing-active' : ''} aria-pressed={featureView === 'detail'} onClick={() => setFeatureView('detail')}>
                  {t.featureViewDetailLabel}
                </button>
                <button className={featureView === 'summary' ? 'mk-billing-active' : ''} aria-pressed={featureView === 'summary'} onClick={() => setFeatureView('summary')}>
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
                        <p className="mk-summary-plus">{t.summaryPlusTemplate.replace('{tier}', t.pricingTiers[i - 1].name)}</p>
                      )}
                      <ul className="mk-summary-list">
                        {getTierBullets(t.featureMatrix, i).map((b) => (
                          <li key={b}>
                            <span className="mk-matrix-check" aria-hidden="true">✓</span>
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
                                      <span className={`mk-matrix-badge ${isUnlimited && i === highlightedIndex ? 'mk-matrix-badge-amber' : ''}`}>{v}</span>
                                    ) : v ? (
                                      <span className="mk-matrix-check" aria-label="✓">✓</span>
                                    ) : (
                                      <span className="mk-matrix-cross" aria-label="✗">✗</span>
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
                  <div>
                    <h3 className="mk-addons-title">{t.addOnsTitle}</h3>
                    <p className="mk-section-subtitle">{t.addOnsSubtitle}</p>
                  </div>
                  <div className="mk-billing-toggle mk-billing-toggle-sm">
                    <button className={!addOnAnnual ? 'mk-billing-active' : ''} aria-pressed={!addOnAnnual} onClick={() => setAddOnAnnual(false)}>
                      {t.billingMonthly}
                    </button>
                    <button className={addOnAnnual ? 'mk-billing-active' : ''} aria-pressed={addOnAnnual} onClick={() => setAddOnAnnual(true)}>
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
                      <a className="mk-btn mk-btn-ghost mk-addon-cta mk-btn-arrow-hover" href={APP_URL}>
                        <ArrowLabel>{t.pricingTiers[0].cta}</ArrowLabel>
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Support: heading + contact list */}
      <section className="mk-section">
        <div className="mk-container mk-support">
          <div className="mk-section-head" data-reveal>
            <h2>{t.supportTitle}</h2>
            <p className="mk-section-subtitle">{t.supportSubtitle}</p>
          </div>
          <ul className="mk-support-list" data-reveal>
            {t.supportCards.map((c, i) => (
              <li key={c.title}>
                <h3>{c.title}</h3>
                <p>{c.desc}</p>
                {i === 2 ? (
                  <Link className="mk-btn mk-btn-ghost" to={path('/help')}>
                    {c.button}
                  </Link>
                ) : (
                  <a className="mk-btn mk-btn-ghost" href="mailto:hello@macrocore.io">
                    {c.button}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="mk-cta-banner">
        <div className="mk-container mk-cta-banner-inner">
          <div>
            <h2>{t.ctaBanner.title}</h2>
            <p>{t.ctaBanner.subtitle}</p>
          </div>
          <a className="mk-btn mk-btn-primary mk-btn-lg mk-btn-arrow-hover" href={APP_URL}>
            {/* One label per intent: the same signup label as the hero and header. */}
            <ArrowLabel>{t.hero.ctaPrimary}</ArrowLabel>
          </a>
        </div>
      </section>
    </>
  );
}
