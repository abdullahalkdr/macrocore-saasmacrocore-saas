// Stage B7 — the dedicated plan page of the trial-to-paid self-service checkout
// (design v3 §6). Rendered OUTSIDE Layout (inside ProtectedRoute + admin-only
// RequireRole in App.tsx) so an expired trial is never bounced to
// /subscription-expired by Layout's own guarded API polling.
//
// Every price, feature, limit, current-plan fact and availability flag comes
// from GET /api/billing/plans. Money is the server's exact decimal string,
// displayed verbatim — this page performs no arithmetic on it. Confirming
// sends ONLY {plan, billing_interval}, plus expected_source_subscription_id
// for a paid-to-paid upgrade (Stage B8, from /plans upgrade.source_subscription_id);
// the server decides everything else.
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { createPurchase, fetchBillingPlans, PlansResponse, startPurchaseCheckout, BillingInterval } from '../../api/billing';
import { useT } from '../../i18n';
import { useLangStore } from '../../store/langStore';
import { useThemeStore } from '../../store/themeStore';
import { IconBuilding } from '../../components/Icon';
import { SALES_EMAIL } from '../../pricingData';
import {
  billingErrorKey,
  blockReasonKey,
  currentPlanKey,
  featureIncluded,
  formatMoney,
  normalizeIntervalParam,
  openPurchaseRelation,
  parsePlanParam,
  planPrice,
  shouldRefetchPlans,
  upgradeBlockKey,
} from './billingHelpers';

// Renders the approved upgrade disclosure verbatim, with the price isolated
// in an LTR <bdi> so the currency sign never flips inside Arabic text. The
// i18n function is called with a private marker in place of the price, and
// the sentence is split around it — the approved wording is never rebuilt.
const PRICE_MARKER = '\u0000PRICE\u0000';
function DisclosureWithPrice({ text, price }: { text: string; price: string }) {
  const [before, after] = text.split(PRICE_MARKER);
  return (
    <>
      {before}
      <bdi dir="ltr" className="billing-amount">{price}</bdi>
      {after ?? ''}
    </>
  );
}

// Shared standalone shell for both billing pages (brand, language + theme
// toggles, a way back into the app). Mirrors SubscriptionExpiredPage's
// "no Layout" approach.
export function BillingShell({ children }: { children: ReactNode }) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const toggleLang = useLangStore((s) => s.toggle);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  return (
    <div className="billing-page">
      <header className="billing-topbar">
        <div className="billing-brand">
          <span className="billing-brand-mark" aria-hidden="true">
            <IconBuilding size={18} />
          </span>
          <span>{t.brand}</span>
        </div>
        <div className="billing-topbar-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={toggleLang}>
            {lang === 'ar' ? 'English' : 'العربية'}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={toggleTheme}>
            {theme === 'dark' ? t.common.lightMode : t.common.darkMode}
          </button>
          <Link to="/dashboard" className="btn btn-secondary btn-sm">
            {t.billing.backToApp}
          </Link>
        </div>
      </header>
      <main className="billing-main">{children}</main>
    </div>
  );
}

function formatDate(iso: string | null, lang: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function PlanCheckoutPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const planKey = parsePlanParam(params.plan);

  const [data, setData] = useState<PlansResponse | null>(null);
  // Stage B8: in upgrade mode the only purchasable interval is the source's
  // (decision O4) — any other ?interval value is replaced, and the cycle
  // toggles are hidden.
  const interval = normalizeIntervalParam(searchParams.get('interval'), data);
  const upgrade = data?.upgrade ?? null;
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = () => {
    setLoadError(false);
    fetchBillingPlans()
      .then(setData)
      .catch(() => setLoadError(true));
  };
  useEffect(load, []);
  useEffect(() => {
    if (!upgrade) return;
    if (searchParams.get('interval') !== upgrade.interval) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set('interval', upgrade.interval);
      setSearchParams(nextParams, { replace: true });
    }
  }, [upgrade, searchParams, setSearchParams]);

  const plan = useMemo(() => data?.plans.find((p) => p.key === planKey) ?? null, [data, planKey]);
  const planName = (key: string) => t.billing.planNames[key] ?? key;

  function setInterval(next: BillingInterval) {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('interval', next);
    setSearchParams(nextParams, { replace: true });
    setActionError(null);
  }

  async function confirmAndPay() {
    if (!planKey || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      // Stage B8: an upgrade sends the source this page rendered (from the
      // same /plans response) as the optimistic-concurrency assertion; a
      // trial purchase sends the exact B7 body.
      const expectedSource = upgrade?.source_subscription_id ?? undefined;
      const { purchase } = await createPurchase(planKey, interval, expectedSource);
      const { checkout_url } = await startPurchaseCheckout(purchase.id);
      window.location.assign(checkout_url);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      setActionError(t.billing.errors[billingErrorKey(code)]);
      setBusy(false);
      // Refresh the server view (availability/eligibility/source may have
      // changed). A stale-context rejection is never auto-resubmitted: the
      // page re-renders with the new source and disclosure first.
      // For a stale context the old disclosure is taken off screen until the
      // fresh /plans response (new source, new end date) has rendered.
      if (shouldRefetchPlans(code)) setData(null);
      fetchBillingPlans()
        .then(setData)
        .catch(() => {
          if (shouldRefetchPlans(code)) setLoadError(true);
        });
    }
  }

  if (loadError) {
    return (
      <BillingShell>
        <div className="error-banner">{t.billing.errors.loadFailed}</div>
        <button type="button" className="btn btn-secondary" onClick={load}>
          {t.billing.retryLoad}
        </button>
      </BillingShell>
    );
  }
  if (!data) {
    return (
      <BillingShell>
        <div className="muted" role="status">{t.billing.loading}</div>
      </BillingShell>
    );
  }
  if (!planKey || !plan) {
    return (
      <BillingShell>
        <div className="empty-state">
          <p>{t.billing.errors.generic}</p>
          <Link to="/billing/plans/silver" className="btn btn-primary">{t.billing.pageTitle}</Link>
        </div>
      </BillingShell>
    );
  }

  const current = currentPlanKey(data.current);
  const onTrial = data.current.subscription_status === 'trial' && !data.current.live_subscription;
  const trialEndsIso = data.current.trial_end_date;
  const trialStillRunning = onTrial && !!trialEndsIso && new Date(trialEndsIso).getTime() > Date.now();
  const price = planPrice(plan, interval);
  const relation = openPurchaseRelation(data.open_purchase, plan.key, interval);
  const standardPlans = data.plans;
  // Stage B8: in upgrade mode the block comes from the upgrade object (a
  // target outside upgrade.targets is "not an upgrade"); otherwise the B7
  // legacy fields apply unchanged.
  const upgradeBlock = upgrade ? upgradeBlockKey(upgrade.block_reason) : null;
  const notAnUpgradeTarget = !!upgrade && !plan.contact_sales && !upgrade.targets.includes(plan.key);
  const block = upgrade ? null : blockReasonKey(data.purchase_block_reason);
  const upgradeBlockText =
    upgradeBlock === null
      ? null
      : upgradeBlock === 'notEligible'
      ? t.billing.errors.notEligible
      : t.billing.blocked[upgradeBlock];
  const sourceEnd = data.current.live_subscription?.current_period_end ?? null;
  const intervalLabel = interval === 'annual' ? t.billing.annual : t.billing.monthly;
  const showCycleToggle = !upgrade;

  return (
    <BillingShell>
      <h1>{t.billing.pageTitle}</h1>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        {onTrial
          ? `${trialStillRunning ? t.billing.trialActive(formatDate(trialEndsIso, lang)) : t.billing.trialEnded} ${t.billing.trialIncludesSilver}`
          : current
          ? `${t.billing.currentPlan}: ${planName(current)}`
          : ''}
      </p>

      <div className="billing-hero">
        {/* Selected plan: price, cycle, features, limits */}
        <section className="card" aria-labelledby="billing-plan-title">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h2 id="billing-plan-title" style={{ margin: 0, fontSize: 20, fontWeight: 900 }}>
              {planName(plan.key)}{' '}
              {current === plan.key && <span className="tag green">{t.billing.currentPlan}</span>}
            </h2>
            {plan.prices && showCycleToggle && (
              <div className="billing-segment" role="group" aria-label={t.billing.billingCycle}>
                <button type="button" aria-pressed={interval === 'monthly'} onClick={() => setInterval('monthly')}>
                  {t.billing.monthly}
                </button>
                <button type="button" aria-pressed={interval === 'annual'} onClick={() => setInterval('annual')}>
                  {t.billing.annual}
                </button>
              </div>
            )}
          </div>

          {price ? (
            <div style={{ margin: '14px 0 6px' }}>
              <bdi dir="ltr" className="billing-price">{formatMoney(price.amount, data.currency)}</bdi>{' '}
              <span className="muted">{interval === 'annual' ? t.billing.perYear : t.billing.perMonth}</span>
              {price.monthlyEquivalent && (
                <div className="muted">
                  {t.billing.monthlyEquivalentPrefix}{' '}
                  <bdi dir="ltr" className="billing-amount">{formatMoney(price.monthlyEquivalent, data.currency)}</bdi>
                  {t.billing.perMonth}
                </div>
              )}
              <div className="billing-footnote">{t.billing.usdNote}</div>
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>{t.billing.enterpriseDesc}</p>
          )}

          <hr className="hr" />
          <h3 style={{ fontSize: 14, margin: '0 0 10px' }}>{t.billing.includes}</h3>
          <ul className="billing-feature-list">
            {data.features
              .filter((f) => featureIncluded(f.min_level, plan.level))
              .map((f) => (
                <li key={f.key}>
                  <span className="billing-check" aria-hidden="true">✓</span>
                  <span>
                    {t.billing.features[f.key] ?? f.key}
                    {f.requires_inventory && <span className="billing-footnote"> *</span>}
                  </span>
                </li>
              ))}
          </ul>
          <h3 style={{ fontSize: 14, margin: '16px 0 8px' }}>{t.billing.limits}</h3>
          <div style={{ fontSize: 13 }}>
            {t.billing.locations}:{' '}
            <strong>{plan.limits.locations === null ? t.billing.unlimited : t.billing.locationsCount(plan.limits.locations)}</strong>
          </div>
          <p className="billing-footnote" style={{ marginBottom: 0 }}>* {t.billing.inventoryFootnote}</p>
        </section>

        {/* Confirmation */}
        <section className="card" aria-labelledby="billing-confirm-title">
          <h2 id="billing-confirm-title" style={{ marginTop: 0, fontSize: 16, fontWeight: 800 }}>
            {plan.contact_sales ? t.billing.enterpriseTitle : t.billing.confirm.title}
          </h2>

          {plan.contact_sales ? (
            <>
              <p className="muted" style={{ fontSize: 13 }}>{t.billing.enterpriseDesc}</p>
              <a className="btn btn-primary" href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent('Enterprise plan')}`}>
                {t.billing.contactSales}
              </a>
            </>
          ) : upgrade ? (
            notAnUpgradeTarget || upgradeBlockText ? (
              <>
                <div className="info-banner" role="status">
                  {notAnUpgradeTarget && upgradeBlock !== 'notEligible' && upgradeBlock !== 'noUpgradeAvailable'
                    ? t.billing.blocked.notAnUpgrade
                    : upgradeBlockText}
                </div>
                {upgradeBlock !== 'notAdmin' && upgradeBlock !== 'sessionRequired' && (
                  <a
                    className="btn btn-secondary"
                    href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent(`Upgrade to ${planName(plan.key)}`)}`}
                  >
                    {t.pricing.ctaUpgradeContact}
                  </a>
                )}
              </>
            ) : (
              <>
                {relation === 'same' && <div className="info-banner">{t.billing.confirm.sameOpen}</div>}
                {relation === 'other' && data.open_purchase && (
                  <div className="info-banner">{t.billing.confirm.replacesOther(planName(data.open_purchase.plan))}</div>
                )}
                <div className="billing-disclosure">
                  <DisclosureWithPrice
                    text={t.billing.confirm.upgradeRule(
                      planName(current ?? ''),
                      planName(plan.key),
                      formatDate(sourceEnd, lang),
                      PRICE_MARKER
                    )}
                    price={price ? formatMoney(price.amount, data.currency) : ''}
                  />
                </div>
                <p className="muted" style={{ fontSize: 12 }}>{t.billing.confirm.sameIntervalNote(intervalLabel)}</p>
                <p className="muted" style={{ fontSize: 12 }}>{t.billing.confirm.windowNote(data.checkout_window_minutes)}</p>
                {actionError && <div className="error-banner" role="alert">{actionError}</div>}
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={confirmAndPay}
                  disabled={busy}
                  aria-busy={busy}
                >
                  {busy ? t.billing.confirm.working : relation === 'same' ? t.billing.confirm.continueButton : t.billing.confirm.upgradeButton}
                </button>
              </>
            )
          ) : block ? (
            <>
              <div className="info-banner" role="status">{t.billing.blocked[block]}</div>
              {block !== 'notAdmin' && block !== 'sessionRequired' && (
                <a
                  className="btn btn-secondary"
                  href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent(`Upgrade to ${planName(plan.key)}`)}`}
                >
                  {t.pricing.ctaUpgradeContact}
                </a>
              )}
            </>
          ) : (
            <>
              {relation === 'same' && <div className="info-banner">{t.billing.confirm.sameOpen}</div>}
              {relation === 'other' && data.open_purchase && (
                <div className="info-banner">{t.billing.confirm.replacesOther(planName(data.open_purchase.plan))}</div>
              )}
              <div className="billing-disclosure">{t.billing.confirm.periodRule}</div>
              <p className="muted" style={{ fontSize: 12 }}>{t.billing.confirm.windowNote(data.checkout_window_minutes)}</p>
              {actionError && <div className="error-banner" role="alert">{actionError}</div>}
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={confirmAndPay}
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? t.billing.confirm.working : relation === 'same' ? t.billing.confirm.continueButton : t.billing.confirm.button}
              </button>
            </>
          )}
        </section>
      </div>

      {/* Comparison */}
      <section className="card no-pad" aria-labelledby="billing-compare-title">
        <div className="card-head">
          <h2 id="billing-compare-title">{t.billing.compareTitle}</h2>
          {showCycleToggle ? (
            <div className="billing-segment" role="group" aria-label={t.billing.billingCycle}>
              <button type="button" aria-pressed={interval === 'monthly'} onClick={() => setInterval('monthly')}>
                {t.billing.monthly}
              </button>
              <button type="button" aria-pressed={interval === 'annual'} onClick={() => setInterval('annual')}>
                {t.billing.annual}
              </button>
            </div>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>{t.billing.confirm.sameIntervalNote(intervalLabel)}</span>
          )}
        </div>
        <div className="table-wrap">
          <table className="billing-compare">
            <thead>
              <tr>
                <th scope="col">{t.billing.featureCol}</th>
                {standardPlans.map((p) => {
                  const pp = planPrice(p, interval);
                  return (
                    <th key={p.key} scope="col" className={`plan-col${p.key === plan.key ? ' is-selected' : ''}`}>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => navigate(`/billing/plans/${p.key}?interval=${interval}`)}
                        style={{ fontWeight: 800, fontSize: 13 }}
                      >
                        {planName(p.key)}
                      </button>
                      <div className="billing-amount" style={{ fontWeight: 700, color: 'var(--text)' }}>
                        {pp ? formatMoney(pp.amount, data.currency) : t.billing.contactSales}
                      </div>
                      {current === p.key && <span className="tag green">{t.billing.currentPlan}</span>}
                      {p.key === plan.key && current !== p.key && <span className="tag amber">{t.billing.selected}</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {data.features.map((f) => (
                <tr key={f.key}>
                  <td>
                    {t.billing.features[f.key] ?? f.key}
                    {f.requires_inventory && <span className="billing-footnote"> *</span>}
                  </td>
                  {standardPlans.map((p) => {
                    const yes = featureIncluded(f.min_level, p.level);
                    return (
                      <td key={p.key} className={`plan-col${p.key === plan.key ? ' is-selected' : ''}`}>
                        {yes ? (
                          <span className="billing-check" aria-label="✓">✓</span>
                        ) : (
                          <span className="billing-dash" aria-label="—">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr>
                <td>{t.billing.locations}</td>
                {standardPlans.map((p) => (
                  <td key={p.key} className={`plan-col${p.key === plan.key ? ' is-selected' : ''}`}>
                    {p.limits.locations === null ? t.billing.unlimited : p.limits.locations}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <p className="billing-footnote">* {t.billing.inventoryFootnote} · {t.billing.usdNote}</p>
    </BillingShell>
  );
}
