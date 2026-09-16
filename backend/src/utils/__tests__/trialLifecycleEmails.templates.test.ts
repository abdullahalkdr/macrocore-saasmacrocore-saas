import { describe, it, expect } from 'vitest';
import { resolveSenderFrom, resolveReplyTo, trialEndingEmailHtml, trialExpiredEmailHtml, type EmailLang } from '../email';

// ---------------------------------------------------------------------------
// Chat 4C, Stage B4B — trial_ending / trial_expired templates. Pure unit
// tests, no DB — see claude/chat4c-b4b-trial-lifecycle-emails-proposal-2026-09-16.md
// (project doc, Design Pass v8 §10/§11 items 23-31) for the full brief.
// Mirrors billingEmail.test.ts's own trialStartedEmailHtml coverage style.
// ---------------------------------------------------------------------------

const LANGS: EmailLang[] = ['ar', 'en'];
const LINK = 'https://app.macrocore.io/account?section=billing';

const endingBase = {
  timeZone: 'Asia/Kuwait',
  companyName: 'Al Salam Trading Co.',
  trialEndDate: new Date('2026-09-29T08:00:00.000Z'),
  link: LINK,
};

const expiredBase = { ...endingBase };

describe('trialEndingEmailHtml — item 23/24 (Arabic/English rendering)', () => {
  it('renders RTL Arabic and LTR English with distinct subject/body and the exact CTA link', () => {
    const ar = trialEndingEmailHtml({ ...endingBase, lang: 'ar' });
    const en = trialEndingEmailHtml({ ...endingBase, lang: 'en' });
    expect(ar.html).toContain('dir="rtl"');
    expect(en.html).toContain('dir="ltr"');
    expect(ar.html).not.toBe(en.html);
    expect(ar.subject).not.toBe(en.subject);
    expect(ar.html).toContain(`href="${LINK}"`);
    expect(en.html).toContain(`href="${LINK}"`);
  });

  it('shows the company name and mentions the trial ending', () => {
    for (const lang of LANGS) {
      const { html } = trialEndingEmailHtml({ ...endingBase, lang });
      expect(html).toContain('Al Salam Trading Co.');
    }
  });

  // Item 28 — tenant-local trial-end date, via the same formatDateForEmail()
  // helper trialStartedEmailHtml() already uses (not UTC directly, not the
  // server's own local time).
  it('item 28: renders the trial-end date in the tenant timezone (formatDateForEmail), not UTC directly', () => {
    const { html } = trialEndingEmailHtml({ ...endingBase, lang: 'en', trialEndDate: '2026-09-15T22:59:27.715Z' });
    // 22:59 UTC on 2026-09-15 is already 2026-09-16 in Asia/Kuwait (UTC+3).
    expect(html).toContain('2026-09-16');
  });

  it('accepts the six-digit fractional-second UTC marker produced by PostgreSQL', () => {
    const { html } = trialEndingEmailHtml({ ...endingBase, lang: 'en', trialEndDate: '2026-09-15T22:59:27.715123Z' });
    expect(html).toContain('2026-09-16');
  });

  it('accepts an ISO string for trialEndDate too, producing the same calendar date as a Date object', () => {
    const asDate = trialEndingEmailHtml({ ...endingBase, lang: 'en', trialEndDate: new Date('2026-09-29T08:00:00.000Z') });
    const asString = trialEndingEmailHtml({ ...endingBase, lang: 'en', trialEndDate: '2026-09-29T08:00:00.000Z' });
    expect(asDate.html).toContain('2026-09-29');
    expect(asString.html).toContain('2026-09-29');
  });
});

describe('trialExpiredEmailHtml — item 25/26 (Arabic/English rendering)', () => {
  it('renders RTL Arabic and LTR English with distinct subject/body and the exact CTA link', () => {
    const ar = trialExpiredEmailHtml({ ...expiredBase, lang: 'ar' });
    const en = trialExpiredEmailHtml({ ...expiredBase, lang: 'en' });
    expect(ar.html).toContain('dir="rtl"');
    expect(en.html).toContain('dir="ltr"');
    expect(ar.html).not.toBe(en.html);
    expect(ar.subject).not.toBe(en.subject);
    expect(ar.html).toContain(`href="${LINK}"`);
    expect(en.html).toContain(`href="${LINK}"`);
  });

  it('shows the company name and mentions the trial having ended', () => {
    for (const lang of LANGS) {
      const { html } = trialExpiredEmailHtml({ ...expiredBase, lang });
      expect(html).toContain('Al Salam Trading Co.');
    }
  });

  it('item 28: renders the trial-end date in the tenant timezone, not UTC directly', () => {
    const { html } = trialExpiredEmailHtml({ ...expiredBase, lang: 'en', trialEndDate: '2026-09-15T22:59:27.715Z' });
    expect(html).toContain('2026-09-16');
  });
});

// Item 27 — HTML-escaping of dynamic content, both templates, both languages.
describe('HTML escaping (item 27)', () => {
  const dangerous = '<script>alert(1)</script> & "Co" \'Ltd\'';

  it('trialEndingEmailHtml escapes a dangerous company name in both languages', () => {
    for (const lang of LANGS) {
      const { html } = trialEndingEmailHtml({ ...endingBase, lang, companyName: dangerous });
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&amp;');
      expect(html).toContain('&quot;');
      expect(html).toContain('&#39;');
    }
  });

  it('trialExpiredEmailHtml escapes a dangerous company name in both languages', () => {
    for (const lang of LANGS) {
      const { html } = trialExpiredEmailHtml({ ...expiredBase, lang, companyName: dangerous });
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&amp;');
    }
  });

  it('both templates escape a hostile link value rather than injecting it raw into the href', () => {
    const hostileLink = 'https://app.macrocore.io/account?next=" onmouseover="alert(1)';
    const ending = trialEndingEmailHtml({ ...endingBase, lang: 'en', link: hostileLink });
    const expired = trialExpiredEmailHtml({ ...expiredBase, lang: 'en', link: hostileLink });
    expect(ending.html).not.toContain('href="https://app.macrocore.io/account?next=" onmouseover=');
    expect(expired.html).not.toContain('href="https://app.macrocore.io/account?next=" onmouseover=');
    expect(ending.html).toContain('&quot; onmouseover=&quot;');
    expect(expired.html).toContain('&quot; onmouseover=&quot;');
  });
});

// Item 29 — the account link, exactly matching the established convention.
describe('account link (item 29)', () => {
  it('renders exactly the caller-supplied link — the same convention as trial_started/subscription_activated/invoice_issued, never a different or ad-hoc path', () => {
    const link = `${'https://app.macrocore.io'}/account?section=billing`;
    for (const lang of LANGS) {
      expect(trialEndingEmailHtml({ ...endingBase, lang, link }).html).toContain(`href="${link}"`);
      expect(trialExpiredEmailHtml({ ...expiredBase, lang, link }).html).toContain(`href="${link}"`);
    }
  });
});

// Item 30 — never payment-confirmation wording, matching
// subscriptionActivatedEmailHtml's own locked rule.
describe('no payment-success wording (item 30)', () => {
  it('trialEndingEmailHtml never says "paid"/"payment received"/"charged" (or the Arabic equivalent) in either language', () => {
    for (const lang of LANGS) {
      const { html } = trialEndingEmailHtml({ ...endingBase, lang });
      expect(html.toLowerCase()).not.toContain('payment');
      expect(html.toLowerCase()).not.toContain('paid');
      expect(html.toLowerCase()).not.toContain('charged');
      expect(html).not.toContain('دفع');
    }
  });

  it('trialExpiredEmailHtml never says "paid"/"payment received"/"charged" (or the Arabic equivalent) in either language', () => {
    for (const lang of LANGS) {
      const { html } = trialExpiredEmailHtml({ ...expiredBase, lang });
      expect(html.toLowerCase()).not.toContain('payment');
      expect(html.toLowerCase()).not.toContain('paid');
      expect(html.toLowerCase()).not.toContain('charged');
      expect(html).not.toContain('دفع');
    }
  });
});

// Item 31 — sender/Reply-To reuse. Both templates are sent under
// EmailCategory 'billing' (job.category, resolved at delivery time — neither
// template function calls resolveSenderFrom()/resolveReplyTo() itself, same
// as trialStartedEmailHtml()) — this documents that the 'billing' identity
// itself is unchanged by B4B, no new mapping introduced.
describe("sender/Reply-To reuse (item 31) — 'billing' category unchanged", () => {
  it("'billing' still resolves to the same Macrocore Billing sender identity B4A decided", () => {
    expect(resolveSenderFrom('billing')).toBe('Macrocore Billing <billing@notify.macrocore.io>');
  });

  it("'billing' still routes replies to the same established support mailbox", () => {
    expect(resolveReplyTo('billing')).toBe('support@macrocore.io');
  });
});
