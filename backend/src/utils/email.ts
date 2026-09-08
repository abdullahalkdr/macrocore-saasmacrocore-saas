import { pool } from '../db/pool';
import { env } from '../config/env';

export type EmailLang = 'ar' | 'en';

// Every transactional category this app sends. Chat 2 (Helpdesk/SLA) and
// Chat 3 (Billing/Subscriptions) extend this union and CATEGORY_FROM below when
// they add their own categories — never invent a second sender-identity or
// delivery-tracking mechanism, this one is meant to be shared.
export type EmailCategory = 'verification' | 'password_reset' | 'security' | 'invitation' | 'approval' | 'test';

// Sender identities under the notify.macrocore.io subdomain — DECIDED in the
// email rollout brief (Section 3), not open for re-evaluation here. These are
// sender-only Resend identities, never cPanel mailboxes — they never receive
// mail, only need Resend's domain authentication (SPF/DKIM/DMARC) on
// notify.macrocore.io. Falls back to env.EMAIL_FROM for any category not yet
// mapped (keeps local dev working before this list is exhaustive).
const CATEGORY_FROM: Record<EmailCategory, string> = {
  verification: 'macrocore <verification@notify.macrocore.io>',
  password_reset: 'macrocore <verification@notify.macrocore.io>',
  security: 'macrocore Security <security@notify.macrocore.io>',
  invitation: 'macrocore <invitations@notify.macrocore.io>',
  approval: 'macrocore Approvals <approvals@notify.macrocore.io>',
  test: 'macrocore <verification@notify.macrocore.io>',
};

// Reply-To routing — brief Section 3 (DECIDED): a real, human-monitored mailbox
// for categories where a recipient reply may need a human. A reply here is NEVER
// parsed or acted on as an in-app action (approvals.controller.ts's actionRequest
// has no code path that reads inbound mail at all — a reply just lands as an
// ordinary support message). Only the four categories the brief names get one;
// security notifications intentionally don't (the email body already tells the
// recipient to contact support directly if the change wasn't them).
const SUPPORT_REPLY_TO = 'support@macrocore.io';
const CATEGORY_REPLY_TO: Partial<Record<EmailCategory, string>> = {
  verification: SUPPORT_REPLY_TO,
  password_reset: SUPPORT_REPLY_TO,
  invitation: SUPPORT_REPLY_TO,
  approval: SUPPORT_REPLY_TO,
};

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  category: EmailCategory;
  // Optional linkage for email_log — null is fine (e.g. nothing company-scoped
  // exists yet at the point a test message is sent).
  companyId?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
}

// Best-effort delivery-tracking row — every send attempt gets exactly one row,
// whatever the outcome. Never throws: email_log itself failing (e.g. this
// migration hasn't been run against this database yet) must not block the real
// send or the business action that triggered it, same fire-and-forget contract
// as the rest of this file.
async function logEmail(
  input: SendEmailInput & { status: 'sent' | 'failed' | 'dev_skipped'; resendMessageId?: string | null; error?: string | null }
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO email_log (company_id, category, recipient_email, subject, status, resend_message_id, related_entity_type, related_entity_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.companyId ?? null,
        input.category,
        input.to,
        input.subject,
        input.status,
        input.resendMessageId ?? null,
        input.relatedEntityType ?? null,
        input.relatedEntityId ?? null,
        input.error ?? null,
      ]
    );
  } catch (err) {
    console.error('[email_log] failed to write row', err);
  }
}

// Single fetch call to Resend's REST API — no SDK dependency for one endpoint. If
// RESEND_API_KEY isn't configured (local dev, or before the domain is verified on
// Resend), we log the email to the console instead of sending — the rest of the
// register/forgot-password/etc. flow still works end-to-end without real
// credentials, and the attempt is still recorded (status='dev_skipped').
// Never throws: a failed/unsent email shouldn't 500 the request that triggered it.
export async function sendEmail(input: SendEmailInput): Promise<void> {
  const replyTo = CATEGORY_REPLY_TO[input.category];

  if (!env.RESEND_API_KEY) {
    console.log(`[email:dev] category=${input.category} to=${input.to} subject="${input.subject}"\n${input.html}\n`);
    await logEmail({ ...input, status: 'dev_skipped' });
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: CATEGORY_FROM[input.category] || env.EMAIL_FROM,
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('sendEmail: Resend request failed', res.status, body);
      await logEmail({ ...input, status: 'failed', error: `HTTP ${res.status}: ${body.slice(0, 500)}` });
      return;
    }
    const json = (await res.json().catch(() => null)) as { id?: string } | null;
    await logEmail({ ...input, status: 'sent', resendMessageId: json?.id ?? null });
  } catch (err) {
    console.error('sendEmail: request threw', err);
    await logEmail({ ...input, status: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
}

// Per-language static copy for the shared shell (button fallback line, footer
// links). Keeps verificationEmailHtml/passwordResetEmailHtml/etc. below from
// each having to repeat this.
const SHELL_COPY: Record<EmailLang, { dir: 'rtl' | 'ltr'; align: 'right' | 'left'; fallbackLine: (link: string) => string; privacy: string; terms: string; footer: string }> = {
  ar: {
    dir: 'rtl',
    align: 'right',
    fallbackLine: (link) =>
      `إذا لم يعمل الزر، انسخ الرابط التالي والصقه في المتصفح:<br><a href="${link}" style="color: #b45309; word-break: break-all;">${link}</a>`,
    privacy: 'سياسة الخصوصية',
    terms: 'الشروط والأحكام',
    footer: '© 2026 macrocore.io — الكويت. جميع الحقوق محفوظة.',
  },
  en: {
    dir: 'ltr',
    align: 'left',
    fallbackLine: (link) =>
      `If the button doesn't work, copy and paste this link into your browser:<br><a href="${link}" style="color: #b45309; word-break: break-all;">${link}</a>`,
    privacy: 'Privacy Policy',
    terms: 'Terms & Conditions',
    footer: '© 2026 macrocore.io — Kuwait. All rights reserved.',
  },
};

// Shared shell so every transactional email looks consistent. Table-based layout
// (not flexbox/div-only) deliberately — Outlook's rendering engine (Word-based) ignores
// most modern CSS, and <table role="presentation"> is the one layout primitive every
// mail client (Gmail, Outlook, Apple Mail, Hotmail) renders the same way. Card-on-gray
// background + colored header bar + footer with real Privacy/Terms links, matching the
// look of mainstream transactional email (Stripe/ESET/etc.) rather than a bare paragraph.
// `lang` flips text direction/alignment and the footer/fallback-link copy — every
// template below picks its own body copy, this only owns the shell chrome.
function emailShell(bodyHtml: string, lang: EmailLang): string {
  const c = SHELL_COPY[lang];
  return `
    <div style="background: #f4f4f5; padding: 32px 16px; font-family: Tahoma, Arial, sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 14px; overflow: hidden; border: 1px solid #e7e5e4;">
        <tr>
          <td style="background: #f59e0b; padding: 26px 32px; text-align: center;">
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 auto;">
              <tr>
                <td style="width: 38px; height: 38px; background: #ffffff; border-radius: 10px; text-align: center; vertical-align: middle; font-weight: 800; font-size: 18px; color: #f59e0b;">m</td>
                <td style="padding-inline-start: 10px; color: #ffffff; font-weight: 800; font-size: 19px; vertical-align: middle;">macrocore</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td dir="${c.dir}" style="padding: 36px 32px 8px; text-align: ${c.align}; color: #1c1917;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td dir="${c.dir}" style="background: #fafaf9; padding: 20px 32px; text-align: ${c.align}; border-top: 1px solid #e7e5e4;">
            <div style="font-size: 12px; color: #78716c;">
              <a href="https://macrocore.io/privacy" style="color: #78716c; text-decoration: underline;">${c.privacy}</a>
              &nbsp;·&nbsp;
              <a href="https://macrocore.io/terms" style="color: #78716c; text-decoration: underline;">${c.terms}</a>
            </div>
            <div style="font-size: 11px; color: #a8a29e; margin-top: 10px;">${c.footer}</div>
          </td>
        </tr>
      </table>
    </div>
  `;
}

// Reusable CTA button + "didn't work? paste this link" fallback — real ESP templates
// always include the raw URL as plain text too, since some clients strip <a> styling
// or block the click entirely.
function ctaButton(link: string, label: string, lang: EmailLang): string {
  return `
    <div style="text-align: center; margin: 28px 0;">
      <a href="${link}" style="display: inline-block; background: #f59e0b; color: #ffffff; text-decoration: none; padding: 14px 40px; border-radius: 10px; font-weight: 700; font-size: 15px;">${label}</a>
    </div>
    <p style="font-size: 12px; color: #a8a29e; line-height: 1.7;">${SHELL_COPY[lang].fallbackLine(link)}</p>
  `;
}

export function verificationEmailHtml(link: string, lang: EmailLang): string {
  if (lang === 'en') {
    return emailShell(
      `
        <p style="font-size: 15px; margin: 0 0 4px;">Welcome 👋</p>
        <p style="font-size: 14px; line-height: 1.8; color: #44403c;">Thanks for signing up to macrocore. Click the button below to verify your email and finish setting up your account:</p>
        ${ctaButton(link, 'Verify email', lang)}
        <p style="font-size: 12px; color: #a8a29e; border-top: 1px solid #f5f5f4; padding-top: 16px;">This link is valid for 24 hours. If you didn't create a macrocore account, you can safely ignore this email.</p>
      `,
      lang
    );
  }
  return emailShell(
    `
      <p style="font-size: 15px; margin: 0 0 4px;">أهلاً بك 👋</p>
      <p style="font-size: 14px; line-height: 1.8; color: #44403c;">شكراً لتسجيلك في macrocore. اضغط الزر أدناه لتفعيل بريدك الإلكتروني وإتمام إعداد حسابك:</p>
      ${ctaButton(link, 'تفعيل البريد الإلكتروني', lang)}
      <p style="font-size: 12px; color: #a8a29e; border-top: 1px solid #f5f5f4; padding-top: 16px;">هذا الرابط صالح لمدة 24 ساعة. إذا لم تُنشئ حساباً بـ macrocore، بإمكانك تجاهل هذه الرسالة بأمان.</p>
    `,
    lang
  );
}

export function passwordResetEmailHtml(link: string, lang: EmailLang): string {
  if (lang === 'en') {
    return emailShell(
      `
        <p style="font-size: 15px; margin: 0 0 4px;">Hi 👋</p>
        <p style="font-size: 14px; line-height: 1.8; color: #44403c;">We received a request to reset your macrocore account password. Click the button below to set a new one:</p>
        ${ctaButton(link, 'Reset password', lang)}
        <p style="font-size: 12px; color: #a8a29e; border-top: 1px solid #f5f5f4; padding-top: 16px;">This link is valid for 30 minutes only. If you didn't request this, ignore this email — your password won't change.</p>
      `,
      lang
    );
  }
  return emailShell(
    `
      <p style="font-size: 15px; margin: 0 0 4px;">أهلاً 👋</p>
      <p style="font-size: 14px; line-height: 1.8; color: #44403c;">وصلنا طلب لإعادة تعيين كلمة مرور حسابك في macrocore. اضغط الزر أدناه لتعيين كلمة مرور جديدة:</p>
      ${ctaButton(link, 'إعادة تعيين كلمة المرور', lang)}
      <p style="font-size: 12px; color: #a8a29e; border-top: 1px solid #f5f5f4; padding-top: 16px;">هذا الرابط صالح لمدة 30 دقيقة فقط. إذا لم تطلب هذا، تجاهل هذه الرسالة — كلمة مرورك لن تتغير.</p>
    `,
    lang
  );
}

// Security notification (brief §2 — "Security notification for sensitive account
// changes") for a password change specifically. Deliberately no CTA/link (nothing
// to click here) — just the fact, the timestamp is implicit in "just now", and a
// direct instruction if it wasn't the account owner.
export function passwordChangedEmailHtml(lang: EmailLang): string {
  if (lang === 'en') {
    return emailShell(
      `
        <p style="font-size: 15px; margin: 0 0 4px;">Security notice</p>
        <p style="font-size: 14px; line-height: 1.8; color: #44403c;">Your macrocore account password was just changed. If this was you, no action is needed.</p>
        <p style="font-size: 13px; line-height: 1.8; color: #b45309; font-weight: 600;">If you did not make this change, contact support immediately at support@macrocore.io.</p>
      `,
      lang
    );
  }
  return emailShell(
    `
      <p style="font-size: 15px; margin: 0 0 4px;">إشعار أمني</p>
      <p style="font-size: 14px; line-height: 1.8; color: #44403c;">تم للتو تغيير كلمة مرور حسابك في macrocore. إذا كنت أنت من قام بهذا، لا حاجة لأي إجراء.</p>
      <p style="font-size: 13px; line-height: 1.8; color: #b45309; font-weight: 600;">إذا لم تكن أنت من غيّر كلمة المرور، تواصل مع الدعم فوراً على support@macrocore.io.</p>
    `,
    lang
  );
}
