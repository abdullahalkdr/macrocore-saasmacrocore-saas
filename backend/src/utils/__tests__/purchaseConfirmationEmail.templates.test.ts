import { describe, expect, it } from 'vitest';
import { formatExactMoneyForEmail, subscriptionPurchaseConfirmedEmailHtml, type SubscriptionPurchaseConfirmedEmailParams } from '../email';

// Stage B8.1 — confirmation template (design v2 §9-§11; T-TPL-1..6).

const BASE: SubscriptionPurchaseConfirmedEmailParams = {
  lang: 'ar',
  timeZone: 'Asia/Kuwait',
  kind: 'purchase',
  testMode: true,
  companyName: 'Acme',
  newPlan: 'bronze',
  previousPlan: null,
  billingInterval: 'monthly',
  amountText: '26.00',
  currency: 'USD',
  invoiceNumber: 'MC-SUB-000042',
  periodStart: '2026-09-24T08:00:00.000000Z',
  periodEnd: '2026-10-24T08:00:00.000000Z',
  confirmedAt: '2026-09-24T09:00:00.000000Z',
  link: 'https://app.macrocore.io/account?section=billing',
};
const render = (over: Partial<SubscriptionPurchaseConfirmedEmailParams> = {}) => subscriptionPurchaseConfirmedEmailHtml({ ...BASE, ...over });

describe('T-TPL-1 — subjects, headings and rows', () => {
  it('Arabic purchase', () => {
    const { subject, html } = render({ testMode: false });
    expect(subject).toBe('تم تأكيد اشتراكك في macrocore');
    expect(html).toContain('تم تأكيد اشتراكك ✅');
    expect(html).toContain('تم تفعيل اشتراك <strong>Acme</strong> في macrocore، ويمكنك الآن استخدام مزايا باقتك الجديدة.');
    for (const label of ['المستوى', 'دورة الفوترة', 'قيمة الاشتراك', 'رقم الفاتورة', 'فترة الاشتراك', 'تاريخ التأكيد', 'عرض الفوترة']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('برونزي');
    expect(html).toContain('شهري');
    expect(html).not.toContain('المستوى السابق');
    expect(html).not.toContain('الباقة:');
  });

  it('Arabic upgrade uses المستوى السابق / المستوى الجديد', () => {
    const { subject, html } = render({ testMode: false, kind: 'upgrade', previousPlan: 'silver', newPlan: 'gold' });
    expect(subject).toBe('تمت ترقية اشتراكك في macrocore');
    expect(html).toContain('تمت ترقية باقتك ✅');
    expect(html).toContain('تمت ترقية اشتراك <strong>Acme</strong> في macrocore، والمزايا الجديدة متاحة الآن.');
    expect(html).toContain('المستوى السابق');
    expect(html).toContain('فضي');
    expect(html).toContain('المستوى الجديد');
    expect(html).toContain('ذهبي');
  });

  it('English purchase and upgrade', () => {
    const p = render({ lang: 'en', testMode: false });
    expect(p.subject).toBe('Your macrocore subscription is confirmed');
    expect(p.html).toContain('Subscription confirmed ✅');
    expect(p.html).toContain("The macrocore subscription for <strong>Acme</strong> is now active, and your new plan's features are available.");
    for (const label of ['Plan', 'Billing interval', 'Subscription price', 'Invoice number', 'Subscription period', 'Confirmation date', 'View billing']) {
      expect(p.html).toContain(label);
    }
    expect(p.html).not.toContain('Previous plan');
    const u = render({ lang: 'en', testMode: false, kind: 'upgrade', previousPlan: 'bronze', newPlan: 'silver' });
    expect(u.subject).toBe('Your macrocore plan has been upgraded');
    expect(u.html).toContain('Plan upgraded ✅');
    expect(u.html).toContain('Previous plan');
    expect(u.html).toContain('New plan');
    expect(u.html).toContain('Bronze');
    expect(u.html).toContain('Silver');
  });

  it('support line and the "not a receipt" footer in both languages and both modes', () => {
    for (const testMode of [true, false]) {
      expect(render({ testMode }).html).toContain('هذه الرسالة تأكيد للاشتراك فقط، وليست إيصال دفع أو فاتورة ضريبية.');
      expect(render({ testMode }).html).toContain('support@macrocore.io');
      expect(render({ lang: 'en', testMode }).html).toContain('This message confirms your subscription. It is not a payment receipt or a tax invoice.');
    }
  });
});

describe('T-TPL-2 — simulator test mode', () => {
  it('test mode: subject prefix and banner in both languages', () => {
    const ar = render({ testMode: true });
    expect(ar.subject).toBe('[تجريبي] تم تأكيد اشتراكك في macrocore');
    expect(ar.html).toContain('رسالة تأكيد تجريبية — لم يتم خصم أي مبلغ حقيقي.');
    const en = render({ lang: 'en', testMode: true, kind: 'upgrade', previousPlan: 'bronze', newPlan: 'gold' });
    expect(en.subject).toBe('[Test] Your macrocore plan has been upgraded');
    expect(en.html).toContain('Test confirmation — no real amount was charged.');
  });

  it('real-provider mode: no prefix, no banner', () => {
    const ar = render({ testMode: false });
    expect(ar.subject.startsWith('[')).toBe(false);
    expect(ar.html).not.toContain('رسالة تأكيد تجريبية');
    const en = render({ lang: 'en', testMode: false });
    expect(en.html).not.toContain('Test confirmation');
  });

  it('never describes a receipt, a charge or a payment in the body wording', () => {
    for (const lang of ['ar', 'en'] as const) {
      const { html } = render({ lang, testMode: false });
      const body = html.replace(/It is not a payment receipt or a tax invoice\.|وليست إيصال دفع أو فاتورة ضريبية\./g, '');
      expect(body).not.toMatch(/receipt|charged|\bpaid\b|إيصال|تم خصم|مدفوع/i);
    }
  });
});

describe('T-TPL-3 — exact decimal amounts', () => {
  it('renders the SQL decimal text verbatim (USD and KWD)', () => {
    expect(render({ amountText: '660.00' }).html).toContain('660.00 USD');
    expect(render({ amountText: '12.345', currency: 'KWD' }).html).toContain('12.345 KWD');
    expect(render({ amountText: '0.10' }).html).toContain('0.10 USD');
  });

  it('wraps the amount in an LTR bdi', () => {
    expect(render({ amountText: '26.00' }).html).toContain('<bdi dir="ltr">26.00 USD</bdi>');
  });

  it('rejects anything that is not an exact decimal string (no number coercion)', () => {
    expect(() => formatExactMoneyForEmail('1e3', 'USD')).toThrow();
    expect(() => formatExactMoneyForEmail('12.5 USD', 'USD')).toThrow();
    expect(() => formatExactMoneyForEmail(26 as unknown as string, 'USD')).toThrow();
    expect(formatExactMoneyForEmail('26.00', 'USD')).toBe('26.00 USD');
  });
});

describe('T-TPL-4 — escaping', () => {
  it('escapes the company name and never puts it in the subject', () => {
    const evil = `<script>alert("x")</script> & 'Co'`;
    for (const lang of ['ar', 'en'] as const) {
      const { subject, html } = render({ lang, companyName: evil });
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;');
      expect(subject).not.toContain('alert');
      expect(subject).not.toContain('Co');
      expect(subject).not.toMatch(/[\r\n]/);
    }
  });

  it('escapes the invoice number', () => {
    expect(render({ invoiceNumber: 'MC<1>' }).html).toContain('#MC&lt;1&gt;');
  });
});

describe('T-TPL-5 — no identifiers, tokens or sensitive URLs', () => {
  it('contains no UUID, bearer token or simulator URL; links only to /account?section=billing', () => {
    for (const lang of ['ar', 'en'] as const) {
      for (const kind of ['purchase', 'upgrade'] as const) {
        const { html } = render({ lang, kind, previousPlan: kind === 'upgrade' ? 'bronze' : null, newPlan: 'gold' });
        expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        expect(html).not.toMatch(/Bearer|simulated-checkout|token|admin[_-]?key|\/billing\/checkout/i);
        const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
        const appLinks = hrefs.filter((h) => !h.startsWith('https://macrocore.io/'));
        expect(new Set(appLinks)).toEqual(new Set(['https://app.macrocore.io/account?section=billing']));
      }
    }
  });
});

describe('T-TPL-6 — dates in the company timezone', () => {
  it('Kuwait midnight edge: 2026-09-23T21:30Z is 2026-09-24 in Asia/Kuwait', () => {
    const { html } = render({ lang: 'en', confirmedAt: '2026-09-23T21:30:00.000000Z', periodStart: '2026-09-23T21:30:00.000000Z', periodEnd: '2026-10-23T21:30:00.000000Z' });
    expect(html).toContain('2026-09-24');
    expect(html).toContain('2026-09-24 → 2026-10-24');
    expect(html).not.toContain('2026-09-23');
  });
});
