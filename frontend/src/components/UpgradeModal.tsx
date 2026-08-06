import { useState } from 'react';
import { useT } from '../i18n';
import { useUpgradeModalStore } from '../store/upgradeModalStore';
import { PLANS, SALES_EMAIL } from '../pricingData';
import { IconClose } from './Icon';

// The Wafeq-style upgrade popup: a blocked-feature banner (only when triggered by an
// actual 403 PLAN_UPGRADE_REQUIRED — see api/client.ts) plus the same pricing cards
// as the public PricingPage, in a wider one-off overlay instead of the standard
// Modal.tsx (that one caps at 520px, too narrow for a 4-column comparison).
//
// CTAs differ from PricingPage on purpose: whoever sees this is already a logged-in
// customer hitting a real wall, not a visitor deciding whether to sign up — "start a
// free trial" makes no sense for them. Until a payment gateway exists, "contact us to
// upgrade" is the only honest CTA (see docs/macrocore-خارطة-طريق.md's payment section
// — Abdullah manually flips a company to the new plan from /platform-admin).
export default function UpgradeModal() {
  const t = useT();
  const open = useUpgradeModalStore((s) => s.open);
  const message = useUpgradeModalStore((s) => s.message);
  const closeModal = useUpgradeModalStore((s) => s.closeModal);
  const [annual, setAnnual] = useState(true);

  if (!open) return null;

  const planTagline: Record<string, string> = {
    bronze: t.pricing.taglineBronze,
    silver: t.pricing.taglineSilver,
    gold: t.pricing.taglineGold,
    enterprise: t.pricing.taglineEnterprise,
  };

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div
        className="modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 980 }}
      >
        <div className="modal-head">
          <h3>{t.pricing.upgradeModalTitle}</h3>
          <button className="modal-close" onClick={closeModal} type="button">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div className="error-banner" style={{ marginBottom: 16 }}>
            {message || t.pricing.blockedBannerDefault}
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            <div style={{ display: 'inline-flex', background: 'var(--surface-alt)', border: '1px solid var(--border)', borderRadius: 999, padding: 4, gap: 4 }}>
              <button
                type="button"
                onClick={() => setAnnual(true)}
                className="btn btn-sm"
                style={{ borderRadius: 999, background: annual ? 'var(--stone-800)' : 'transparent', color: annual ? '#fff' : 'var(--text)', border: 'none' }}
              >
                {t.pricing.annual}
              </button>
              <button
                type="button"
                onClick={() => setAnnual(false)}
                className="btn btn-sm"
                style={{ borderRadius: 999, background: !annual ? 'var(--stone-800)' : 'transparent', color: !annual ? '#fff' : 'var(--text)', border: 'none' }}
              >
                {t.pricing.monthly}
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            {PLANS.map((plan) => {
              const usdPrice = annual ? plan.annualMonthlyUsd : plan.monthlyUsd;
              const kdPrice = annual ? plan.annualKd : plan.monthlyKd;
              return (
                <div
                  key={plan.key}
                  className="card"
                  style={{ position: 'relative', padding: 16, border: plan.featured ? '2px solid var(--amber-500)' : '1px solid var(--border)' }}
                >
                  {plan.featured && (
                    <span
                      style={{
                        position: 'absolute',
                        top: -11,
                        insetInlineStart: '50%',
                        transform: 'translateX(50%)',
                        background: 'var(--amber-500)',
                        color: '#fff',
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 999,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t.pricing.mostPopular}
                    </span>
                  )}
                  <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>{plan.name}</div>
                  <p className="muted" style={{ fontSize: 11.5, minHeight: 44, marginBottom: 10 }}>
                    {planTagline[plan.key]}
                  </p>
                  {plan.contactSales ? (
                    <div style={{ minHeight: 46, display: 'flex', alignItems: 'center', marginBottom: 10 }}>
                      <div style={{ fontWeight: 800, fontSize: 13 }}>{t.pricing.ctaContactSales}</div>
                    </div>
                  ) : (
                    <div style={{ minHeight: 46, marginBottom: 10 }}>
                      <span style={{ fontWeight: 800, fontSize: 20 }}>${usdPrice}</span>
                      <span className="muted" style={{ fontSize: 11 }}> {t.pricing.perMonth}</span>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {t.pricing.approx} {kdPrice?.toFixed(3)} KD
                      </div>
                    </div>
                  )}
                  <a
                    href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent(`Upgrade to ${plan.name}`)}`}
                    className={plan.featured ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                    style={{ width: '100%', display: 'block', textAlign: 'center' }}
                  >
                    {plan.contactSales ? t.pricing.ctaContactSales : t.pricing.ctaUpgradeContact}
                  </a>
                </div>
              );
            })}
          </div>

          <p className="muted" style={{ textAlign: 'center', fontSize: 11, marginTop: 16, marginBottom: 0 }}>
            {t.pricing.currencyNote}
          </p>
        </div>
      </div>
    </div>
  );
}
