import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { IconBuilding } from '../components/Icon';

// Public marketing page — no auth required (see App.tsx: "/" routes here for
// logged-out visitors). Pricing numbers below are Abdullah's own figures (USD is the
// real billing currency; KD is shown as an approximate secondary line only — see
// pricing.currencyNote). Nothing here is wired to real billing yet (no payment
// gateway chosen), so every CTA just leads to the free-trial signup wizard
// (/register) — picking a card doesn't provision anything different yet.
const SALES_EMAIL = 'abdullahkhaled37@gmail.com';

interface Plan {
  key: string;
  name: string;
  monthlyUsd: number | null;
  annualMonthlyUsd: number | null;
  monthlyKd: number | null;
  annualKd: number | null;
  featured?: boolean;
  contactSales?: boolean;
}

// DOM order is cheapest → most expensive. The page is rendered dir="rtl" (see
// App.tsx), which visually reverses this to Enterprise (left) ... Bronze (right) —
// matching the reference layout without needing separate mobile/desktop ordering.
const PLANS: Plan[] = [
  { key: 'bronze', name: 'Bronze', monthlyUsd: 32, annualMonthlyUsd: 26, monthlyKd: 9.9, annualKd: 8.0 },
  { key: 'silver', name: 'Silver', monthlyUsd: 39, annualMonthlyUsd: 32, monthlyKd: 12.0, annualKd: 9.9, featured: true },
  { key: 'gold', name: 'Gold', monthlyUsd: 67, annualMonthlyUsd: 55, monthlyKd: 20.75, annualKd: 17.0 },
  { key: 'enterprise', name: 'Enterprise', monthlyUsd: null, annualMonthlyUsd: null, monthlyKd: null, annualKd: null, contactSales: true },
];

interface Addon {
  key: string;
  monthlyUsd: number;
  monthlyKd: number;
  annualUsd: number;
  annualKd: number;
}
const ADDONS: Addon[] = [
  { key: 'revenue', monthlyUsd: 39, monthlyKd: 12.08, annualUsd: 390, annualKd: 120.8 },
  { key: 'custom', monthlyUsd: 29, monthlyKd: 8.98, annualUsd: 290, annualKd: 89.8 },
  { key: 'branch', monthlyUsd: 9, monthlyKd: 2.79, annualUsd: 90, annualKd: 27.9 },
];

export default function PricingPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const toggleLang = useLangStore((s) => s.toggle);
  const [annual, setAnnual] = useState(true);

  const planTagline: Record<string, string> = {
    bronze: t.pricing.taglineBronze,
    silver: t.pricing.taglineSilver,
    gold: t.pricing.taglineGold,
    enterprise: t.pricing.taglineEnterprise,
  };
  const addonTitle: Record<string, string> = {
    revenue: t.pricing.addonRevenueTitle,
    custom: t.pricing.addonCustomTitle,
    branch: t.pricing.addonBranchTitle,
  };
  const addonDesc: Record<string, string> = {
    revenue: t.pricing.addonRevenueDesc,
    custom: t.pricing.addonCustomDesc,
    branch: t.pricing.addonBranchDesc,
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 1120, margin: '0 auto', padding: '24px 20px 64px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 40 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 34,
                height: 34,
                background: 'var(--amber-500)',
                borderRadius: 9,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
              }}
            >
              <IconBuilding size={18} />
            </div>
            <strong>{t.brand}</strong>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 13 }}>
            <button type="button" onClick={toggleLang} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13 }}>
              {lang === 'ar' ? 'English' : 'العربية'}
            </button>
            <span className="muted">{t.pricing.haveAccount}</span>
            <Link to="/login" className="btn btn-secondary btn-sm">
              {t.pricing.logIn}
            </Link>
          </div>
        </div>

        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <h1 style={{ fontSize: 32, marginBottom: 8 }}>{t.pricing.title}</h1>
          <p className="muted" style={{ fontSize: 15 }}>{t.pricing.subtitle}</p>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
          <div style={{ display: 'inline-flex', background: 'var(--surface-alt)', border: '1px solid var(--border)', borderRadius: 999, padding: 4, gap: 4 }}>
            <button
              type="button"
              onClick={() => setAnnual(true)}
              className="btn btn-sm"
              style={{
                borderRadius: 999,
                background: annual ? 'var(--stone-800)' : 'transparent',
                color: annual ? '#fff' : 'var(--text)',
                border: 'none',
              }}
            >
              {t.pricing.annual}
            </button>
            <button
              type="button"
              onClick={() => setAnnual(false)}
              className="btn btn-sm"
              style={{
                borderRadius: 999,
                background: !annual ? 'var(--stone-800)' : 'transparent',
                color: !annual ? '#fff' : 'var(--text)',
                border: 'none',
              }}
            >
              {t.pricing.monthly}
            </button>
          </div>
        </div>
        {annual && (
          <p className="muted" style={{ textAlign: 'center', fontSize: 12, marginBottom: 28 }}>
            {t.pricing.annualNote}
          </p>
        )}
        {!annual && <div style={{ marginBottom: 28 }} />}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 12 }}>
          {PLANS.map((plan) => {
            const usdPrice = annual ? plan.annualMonthlyUsd : plan.monthlyUsd;
            const kdPrice = annual ? plan.annualKd : plan.monthlyKd;
            return (
              <div
                key={plan.key}
                className="card"
                style={{
                  position: 'relative',
                  padding: 20,
                  border: plan.featured ? '2px solid var(--amber-500)' : '1px solid var(--border)',
                }}
              >
                {plan.featured && (
                  <span
                    style={{
                      position: 'absolute',
                      top: -12,
                      insetInlineStart: '50%',
                      transform: 'translateX(50%)',
                      background: 'var(--amber-500)',
                      color: '#fff',
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '3px 10px',
                      borderRadius: 999,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t.pricing.mostPopular}
                  </span>
                )}
                <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 6 }}>{plan.name}</div>
                <p className="muted" style={{ fontSize: 12.5, minHeight: 36, marginBottom: 14 }}>
                  {planTagline[plan.key]}
                </p>

                {plan.contactSales ? (
                  <div style={{ minHeight: 62, display: 'flex', alignItems: 'center', marginBottom: 14 }}>
                    <div style={{ fontWeight: 800, fontSize: 16 }}>{t.pricing.ctaContactSales}</div>
                  </div>
                ) : (
                  <div style={{ minHeight: 62, marginBottom: 14 }}>
                    <div>
                      <span style={{ fontWeight: 800, fontSize: 26 }}>${usdPrice}</span>
                      <span className="muted" style={{ fontSize: 13 }}> {t.pricing.perMonth}</span>
                    </div>
                    {annual && plan.monthlyUsd !== usdPrice && (
                      <span className="muted" style={{ fontSize: 13, textDecoration: 'line-through' }}>${plan.monthlyUsd}</span>
                    )}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {t.pricing.approx} {kdPrice?.toFixed(3)} KD
                    </div>
                  </div>
                )}

                {plan.contactSales ? (
                  <a href={`mailto:${SALES_EMAIL}?subject=Enterprise%20plan`} className="btn btn-secondary" style={{ width: '100%', display: 'block', textAlign: 'center' }}>
                    {t.pricing.ctaContactSales}
                  </a>
                ) : (
                  <Link
                    to="/register"
                    className={plan.featured ? 'btn btn-primary' : 'btn btn-secondary'}
                    style={{ width: '100%', display: 'block', textAlign: 'center' }}
                  >
                    {t.pricing.ctaStartTrial}
                  </Link>
                )}
              </div>
            );
          })}
        </div>

        <p className="muted" style={{ textAlign: 'center', fontSize: 11.5, marginBottom: 56 }}>
          {t.pricing.currencyNote}
        </p>

        <div style={{ marginBottom: 12 }}>
          <h2 style={{ fontSize: 22, marginBottom: 4 }}>{t.pricing.addonsTitle}</h2>
          <p className="muted" style={{ fontSize: 13 }}>{t.pricing.addonsSubtitle}</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {ADDONS.map((addon) => {
            const usdPrice = annual ? addon.annualUsd : addon.monthlyUsd;
            const kdPrice = annual ? addon.annualKd : addon.monthlyKd;
            return (
              <div key={addon.key} className="card" style={{ padding: 20 }}>
                <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 6 }}>{addonTitle[addon.key]}</div>
                <p className="muted" style={{ fontSize: 12.5, minHeight: 36, marginBottom: 14 }}>
                  {addonDesc[addon.key]}
                </p>
                <div style={{ marginBottom: 14 }}>
                  <span style={{ fontWeight: 800, fontSize: 22 }}>${usdPrice}</span>
                  <span className="muted" style={{ fontSize: 13 }}> {annual ? t.pricing.perYear : t.pricing.perMonth}</span>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t.pricing.approx} {kdPrice.toFixed(3)} KD
                  </div>
                </div>
                <Link to="/register" className="btn btn-secondary" style={{ width: '100%', display: 'block', textAlign: 'center' }}>
                  {t.pricing.ctaStartTrial}
                </Link>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
