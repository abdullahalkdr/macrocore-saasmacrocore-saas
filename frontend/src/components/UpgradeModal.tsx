import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '../i18n';
import { useUpgradeModalStore } from '../store/upgradeModalStore';
import { useAuthStore } from '../store/authStore';
import { SALES_EMAIL } from '../pricingData';
import { fetchBillingPlans, PlansResponse } from '../api/billing';
import { currentPlanKey, formatMoney, planCta, planPrice, upgradeIntervalFor } from '../pages/billing/billingHelpers';
import { IconClose } from './Icon';

// The Wafeq-style upgrade popup ("ترقية باقتك"): an optional blocked-feature
// banner (shown only when a message is passed — a real 403
// PLAN_UPGRADE_REQUIRED from api/client.ts, or a locked nav item in
// Layout.tsx) plus one card per plan, in a wider one-off overlay instead of
// the standard Modal.tsx (that one caps at 520px, too narrow for 4 columns).
//
// Stage B7 (design v3 §6.1): every price, plan level and the current plan now
// come from the server catalogue (GET /api/billing/plans) — this modal no
// longer reads prices from pricingData.ts (that file now serves only the
// public, unauthenticated PricingPage). Choosing a standard plan takes a
// tenant admin to the dedicated plan page (/billing/plans/:plan), which shows
// the full features/limits/comparison and — only where the server says
// self-service checkout is available — the confirm button. Non-admins are
// told to ask their account admin; Enterprise stays contact-sales. If the
// catalogue cannot be loaded, the honest "contact us" CTA remains.
export default function UpgradeModal() {
  const t = useT();
  const navigate = useNavigate();
  const open = useUpgradeModalStore((s) => s.open);
  const message = useUpgradeModalStore((s) => s.message);
  const closeModal = useUpgradeModalStore((s) => s.closeModal);
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [annual, setAnnual] = useState(true);
  const [plans, setPlans] = useState<PlansResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoadFailed(false);
    fetchBillingPlans()
      .then(setPlans)
      .catch(() => {
        setPlans(null);
        setLoadFailed(true);
      });
  }, [open]);

  if (!open) return null;

  const planTagline: Record<string, string> = {
    bronze: t.pricing.taglineBronze,
    silver: t.pricing.taglineSilver,
    gold: t.pricing.taglineGold,
    enterprise: t.pricing.taglineEnterprise,
  };
  // Stage B8: in upgrade mode the cycle is locked to the current
  // subscription's interval (decision O4) and the toggle is hidden.
  const lockedInterval = upgradeIntervalFor(plans);
  const interval = lockedInterval ?? (annual ? 'annual' : 'monthly');
  const current = plans ? currentPlanKey(plans.current) : null;
  const cards = plans?.plans ?? [];

  function choose(planKey: string) {
    closeModal();
    navigate(`/billing/plans/${planKey}?interval=${interval}`);
  }

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div
        className="modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 980 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="upgrade-modal-title"
      >
        <div className="modal-head">
          <h3 id="upgrade-modal-title">{t.pricing.upgradeModalTitle}</h3>
          <button className="modal-close" onClick={closeModal} type="button" aria-label={t.common.close}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          {message && (
            <div className="error-banner" style={{ marginBottom: 16 }}>
              {message}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            {lockedInterval ? (
              <span className="muted" style={{ fontSize: 12 }}>
                {t.billing.confirm.sameIntervalNote(lockedInterval === 'annual' ? t.billing.annual : t.billing.monthly)}
              </span>
            ) : (
              <div className="billing-segment" role="group" aria-label={t.billing.billingCycle}>
                <button type="button" aria-pressed={annual} onClick={() => setAnnual(true)}>
                  {t.pricing.annual}
                </button>
                <button type="button" aria-pressed={!annual} onClick={() => setAnnual(false)}>
                  {t.pricing.monthly}
                </button>
              </div>
            )}
          </div>

          {loadFailed && (
            <div style={{ textAlign: 'center' }}>
              <div className="info-banner">{t.billing.modal.loadFailed}</div>
              <a href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent('Upgrade')}`} className="btn btn-primary">
                {t.pricing.ctaUpgradeContact}
              </a>
            </div>
          )}
          {!plans && !loadFailed && <div className="muted" role="status">{t.billing.loading}</div>}

          {plans && (
            <div className="billing-plan-grid">
              {cards.map((plan) => {
                const price = planPrice(plan, interval);
                const cta = planCta(plan.key, isAdmin, plans);
                const isCurrent = current === plan.key;
                const name = t.billing.planNames[plan.key] ?? plan.key;
                return (
                  <div key={plan.key} className={`card billing-plan-card${isCurrent ? ' is-current' : ''}`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                      <div style={{ fontWeight: 800, fontSize: 15 }}>{name}</div>
                      {isCurrent && <span className="tag green">{t.billing.currentPlan}</span>}
                    </div>
                    <p className="muted" style={{ fontSize: 11.5, minHeight: 36, margin: 0 }}>
                      {planTagline[plan.key]}
                    </p>
                    {price ? (
                      <div style={{ minHeight: 46 }}>
                        {price.monthlyEquivalent ? (
                          <>
                            <bdi dir="ltr" className="billing-amount" style={{ fontWeight: 800, fontSize: 20 }}>
                              {formatMoney(price.monthlyEquivalent, plans.currency)}
                            </bdi>
                            <span className="muted"> {t.billing.perMonth}</span>
                            <div className="muted">
                              <bdi dir="ltr" className="billing-amount">{formatMoney(price.amount, plans.currency)}</bdi>{' '}
                              {t.billing.billedAnnuallySuffix}
                            </div>
                          </>
                        ) : (
                          <>
                            <bdi dir="ltr" className="billing-amount" style={{ fontWeight: 800, fontSize: 20 }}>
                              {formatMoney(price.amount, plans.currency)}
                            </bdi>
                            <span className="muted"> {t.billing.perMonth}</span>
                          </>
                        )}
                      </div>
                    ) : (
                      <div style={{ minHeight: 46, display: 'flex', alignItems: 'center', fontWeight: 800, fontSize: 13 }}>
                        {t.pricing.ctaContactSales}
                      </div>
                    )}
                    {cta === 'choose' && (
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => choose(plan.key)}>
                        {t.billing.modal.choose}
                      </button>
                    )}
                    {cta === 'upgrade' && (
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => choose(plan.key)}>
                        {t.billing.modal.upgrade}
                      </button>
                    )}
                    {cta === 'lower' && (
                      <div className="muted" style={{ textAlign: 'center', marginTop: 'auto' }}>
                        {t.billing.modal.lowerPlan}
                      </div>
                    )}
                    {cta === 'contact_sales' && (
                      <a
                        href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent('Enterprise plan')}`}
                        className="btn btn-secondary btn-sm"
                      >
                        {t.pricing.ctaContactSales}
                      </a>
                    )}
                    {cta === 'ask_admin' && (
                      <div className="muted" style={{ textAlign: 'center', marginTop: 'auto' }}>
                        {t.billing.modal.askAdmin}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <p className="muted" style={{ textAlign: 'center', fontSize: 11, marginTop: 16, marginBottom: 0 }}>
            {t.billing.usdNote}
          </p>
        </div>
      </div>
    </div>
  );
}
