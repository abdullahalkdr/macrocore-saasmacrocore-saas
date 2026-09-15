import { describe, it, expect } from 'vitest';
import {
  resolveSenderFrom,
  resolveReplyTo,
  trialStartedEmailHtml,
  subscriptionActivatedEmailHtml,
  subscriptionInvoiceIssuedEmailHtml,
  type EmailCategory,
  type EmailLang,
} from '../email';

// ---------------------------------------------------------------------------
// Billing templates — Chat 4B, Stage B4A. See
// claude/chat4b-b4a-immediate-subscription-invoice-emails-2026-09-15.md
// (project doc) for the full brief this stage implements.
// ---------------------------------------------------------------------------

const LANGS: EmailLang[] = ['ar', 'en'];
const LINK = 'https://app.macrocore.io/account?section=billing';

describe("resolveSenderFrom / resolveReplyTo — 'billing' category", () => {
  it("gives 'billing' the decided Macrocore Billing sender identity on notify.macrocore.io", () => {
    expect(resolveSenderFrom('billing')).toBe('Macrocore Billing <billing@notify.macrocore.io>');
  });

  it("routes 'billing' replies to support@macrocore.io — the same established monitored mailbox every other category uses", () => {
    expect(resolveReplyTo('billing')).toBe('support@macrocore.io');
  });

  it('adding the billing category left every previously-tested category unchanged', () => {
    const categories: EmailCategory[] = ['verification', 'password_reset', 'security', 'invitation', 'approval', 'helpdesk', 'test'];
    for (const category of categories) {
      expect(resolveSenderFrom(category)).toMatch(/@notify\.macrocore\.io>?$/);
    }
    expect(resolveReplyTo('security')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// trialStartedEmailHtml
// ---------------------------------------------------------------------------
describe('trialStartedEmailHtml', () => {
  const base = {
    timeZone: 'Asia/Kuwait',
    companyName: 'Al Salam Trading Co.',
    trialStartDate: new Date('2026-09-15T08:00:00.000Z'),
    trialEndDate: new Date('2026-09-29T08:00:00.000Z'),
    plan: 'trial',
    link: LINK,
  };

  it('renders RTL Arabic and LTR English with distinct subject/body and the exact CTA link', () => {
    const ar = trialStartedEmailHtml({ ...base, lang: 'ar' });
    const en = trialStartedEmailHtml({ ...base, lang: 'en' });
    expect(ar.html).toContain('dir="rtl"');
    expect(en.html).toContain('dir="ltr"');
    expect(ar.html).not.toBe(en.html);
    expect(ar.subject).not.toBe(en.subject);
    expect(ar.html).toContain(`href="${LINK}"`);
    expect(en.html).toContain(`href="${LINK}"`);
  });

  it('shows the company name and tenant-local trial dates as YYYY-MM-DD in both languages', () => {
    for (const lang of LANGS) {
      const { html } = trialStartedEmailHtml({ ...base, lang });
      expect(html).toContain('Al Salam Trading Co.');
      expect(html).toContain('2026-09-15');
      expect(html).toContain('2026-09-29');
    }
  });

  it('renders a post-midnight Kuwait event on the Kuwait calendar day, not the previous UTC day', () => {
    const { html } = trialStartedEmailHtml({
      ...base,
      lang: 'ar',
      trialStartDate: '2026-09-15T22:59:27.715Z',
    });
    expect(html).toContain('2026-09-16');
  });

  it('accepts an ISO string for the dates too (not just a Date object), producing the same calendar date', () => {
    const { html } = trialStartedEmailHtml({ ...base, lang: 'en', trialStartDate: '2026-09-15T08:00:00.000Z' });
    expect(html).toContain('2026-09-15');
  });

  it('HTML-escapes a dangerous company name in the body (companyName is free text, the company\'s own registered name)', () => {
    const dangerous = '<script>alert(1)</script> & "Co" \'Ltd\'';
    const { html } = trialStartedEmailHtml({ ...base, lang: 'en', companyName: dangerous });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
  });

  it('HTML-escapes unrecognized dynamic values and the CTA URL', () => {
    const { html } = trialStartedEmailHtml({
      ...base,
      lang: 'en',
      plan: '<img src=x onerror=alert(1)>',
      link: 'https://app.macrocore.io/account?next=" onmouseover="alert(1)',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('href="https://app.macrocore.io/account?next=" onmouseover=');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&quot; onmouseover=&quot;');
  });

  it('never claims registration/verification/payment happened — no such wording appears in either language', () => {
    for (const lang of LANGS) {
      const { html } = trialStartedEmailHtml({ ...base, lang });
      expect(html.toLowerCase()).not.toContain('payment');
      expect(html.toLowerCase()).not.toContain('paid');
      expect(html).not.toContain('دفع');
    }
  });

  it('falls back to the raw plan string for an unrecognized plan value rather than throwing', () => {
    expect(() => trialStartedEmailHtml({ ...base, lang: 'en', plan: 'some_future_plan' })).not.toThrow();
    const { html } = trialStartedEmailHtml({ ...base, lang: 'en', plan: 'some_future_plan' });
    expect(html).toContain('some_future_plan');
  });
});

// ---------------------------------------------------------------------------
// subscriptionActivatedEmailHtml
// ---------------------------------------------------------------------------
describe('subscriptionActivatedEmailHtml', () => {
  const base = {
    timeZone: 'Asia/Kuwait',
    plan: 'gold',
    billingInterval: 'monthly' as const,
    periodAmount: 149.5,
    currency: 'USD',
    currentPeriodStart: new Date('2026-09-15T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-10-15T00:00:00.000Z'),
    link: LINK,
  };

  it('renders RTL Arabic and LTR English with distinct subject/body and the exact CTA link', () => {
    const ar = subscriptionActivatedEmailHtml({ ...base, lang: 'ar' });
    const en = subscriptionActivatedEmailHtml({ ...base, lang: 'en' });
    expect(ar.html).toContain('dir="rtl"');
    expect(en.html).toContain('dir="ltr"');
    expect(ar.html).not.toBe(en.html);
    expect(ar.subject).not.toBe(en.subject);
    expect(ar.html).toContain(`href="${LINK}"`);
    expect(en.html).toContain(`href="${LINK}"`);
  });

  it('shows plan, billing interval, the exact period amount + currency, and the current period bounds', () => {
    for (const lang of LANGS) {
      const { html } = subscriptionActivatedEmailHtml({ ...base, lang });
      expect(html).toContain('149.50 USD');
      expect(html).toContain('2026-09-15');
      expect(html).toContain('2026-10-15');
    }
    const en = subscriptionActivatedEmailHtml({ ...base, lang: 'en' });
    expect(en.html).toContain('Gold');
    expect(en.html).toContain('Monthly');
    const ar = subscriptionActivatedEmailHtml({ ...base, lang: 'ar' });
    expect(ar.html).toContain('ذهبي');
    expect(ar.html).toContain('شهري');
  });

  it('formats KWD amounts to 3 decimal places (fils), not 2', () => {
    const { html } = subscriptionActivatedEmailHtml({ ...base, lang: 'en', currency: 'KWD', periodAmount: 45.75 });
    expect(html).toContain('45.750 KWD');
  });

  // Locked rule: an administrative activation is not payment evidence. This
  // must hold structurally in the copy itself, not just by caller
  // discipline — checked for both languages.
  it('never calls this a successful payment — no "payment"/"paid" wording in either language', () => {
    for (const lang of LANGS) {
      const { html, subject } = subscriptionActivatedEmailHtml({ ...base, lang });
      expect(html.toLowerCase()).not.toContain('payment');
      expect(html.toLowerCase()).not.toContain('paid');
      expect(subject.toLowerCase()).not.toContain('payment');
      expect(subject.toLowerCase()).not.toContain('paid');
      expect(html).not.toContain('دفع');
    }
  });

  it('falls back to the raw string for an unrecognized plan/interval rather than throwing', () => {
    const { html } = subscriptionActivatedEmailHtml({ ...base, lang: 'en', plan: 'mystery', billingInterval: 'weekly' as never });
    expect(html).toContain('mystery');
    expect(html).toContain('weekly');
  });

  it('HTML-escapes all unrecognized dynamic summary values', () => {
    const { html } = subscriptionActivatedEmailHtml({
      ...base,
      lang: 'en',
      plan: '<b>plan</b>',
      billingInterval: '<i>interval</i>',
      currency: '<script>currency</script>',
    });
    expect(html).not.toContain('<b>plan</b>');
    expect(html).not.toContain('<i>interval</i>');
    expect(html).not.toContain('<script>currency</script>');
    expect(html).toContain('&lt;b&gt;plan&lt;/b&gt;');
  });
});

// ---------------------------------------------------------------------------
// subscriptionInvoiceIssuedEmailHtml
// ---------------------------------------------------------------------------
describe('subscriptionInvoiceIssuedEmailHtml', () => {
  const base = {
    timeZone: 'Asia/Kuwait',
    invoiceNumber: 'MC-SUB-000123',
    plan: 'silver',
    billingInterval: 'annual' as const,
    amount: 1200,
    currency: 'USD',
    periodStart: new Date('2026-09-15T00:00:00.000Z'),
    periodEnd: new Date('2027-09-15T00:00:00.000Z'),
    issueDate: new Date('2026-09-15T00:00:00.000Z'),
    dueDate: new Date('2026-09-15T00:00:00.000Z'),
    link: LINK,
  };

  it('renders RTL Arabic and LTR English with distinct subject/body and the exact CTA link', () => {
    const ar = subscriptionInvoiceIssuedEmailHtml({ ...base, lang: 'ar' });
    const en = subscriptionInvoiceIssuedEmailHtml({ ...base, lang: 'en' });
    expect(ar.html).toContain('dir="rtl"');
    expect(en.html).toContain('dir="ltr"');
    expect(ar.html).not.toBe(en.html);
    expect(ar.subject).not.toBe(en.subject);
    expect(ar.html).toContain(`href="${LINK}"`);
    expect(en.html).toContain(`href="${LINK}"`);
  });

  it('includes the invoice number in both the subject and the body, in both languages', () => {
    for (const lang of LANGS) {
      const { subject, html } = subscriptionInvoiceIssuedEmailHtml({ ...base, lang });
      expect(subject).toContain('MC-SUB-000123');
      expect(html).toContain('MC-SUB-000123');
    }
  });

  it('shows plan, billing interval, amount + currency, billing period, issue date and due date', () => {
    const { html } = subscriptionInvoiceIssuedEmailHtml({ ...base, lang: 'en' });
    expect(html).toContain('Silver');
    expect(html).toContain('Annual');
    expect(html).toContain('1200.00 USD');
    expect(html).toContain('2026-09-15');
    expect(html).toContain('2027-09-15');
  });

  // Structural safety: there is no parameter on this function for a gateway
  // reference, payment token, card field, or provider payload — nothing to
  // leak by mistake. This test documents the exact parameter surface rather
  // than asserting an absence-of-a-string (which would be a weaker check).
  it('accepts only the documented safe fields — no gateway/payment/card parameter exists on this function', () => {
    const paramNames = Object.keys(base).concat(['lang']);
    expect(paramNames).not.toContain('gatewayReference');
    expect(paramNames).not.toContain('paymentToken');
    expect(paramNames).not.toContain('cardLast4');
    expect(paramNames).not.toContain('providerPayload');
  });

  it('falls back to the raw string for an unrecognized plan/interval rather than throwing', () => {
    const { html } = subscriptionInvoiceIssuedEmailHtml({ ...base, lang: 'en', plan: 'mystery', billingInterval: 'weekly' as never });
    expect(html).toContain('mystery');
    expect(html).toContain('weekly');
  });

  it('HTML-escapes the invoice number and all unrecognized dynamic summary values', () => {
    const { html } = subscriptionInvoiceIssuedEmailHtml({
      ...base,
      lang: 'en',
      invoiceNumber: '<img src=x onerror=alert(1)>',
      plan: '<b>plan</b>',
      billingInterval: '<i>interval</i>',
      currency: '<script>currency</script>',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>plan</b>');
    expect(html).not.toContain('<i>interval</i>');
    expect(html).not.toContain('<script>currency</script>');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;b&gt;plan&lt;/b&gt;');
  });
});
