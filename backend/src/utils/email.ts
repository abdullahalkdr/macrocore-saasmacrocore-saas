import { env } from '../config/env';

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

// Single fetch call to Resend's REST API — no SDK dependency for one endpoint. If
// RESEND_API_KEY isn't configured (local dev, or before the domain is verified on
// Resend), we log the email to the console instead of sending — the rest of the
// register/forgot-password/etc. flow still works end-to-end without real credentials.
// Never throws: a failed/unsent email shouldn't 500 the request that triggered it (e.g.
// register() should still succeed even if the verification email fails — the user can
// hit "resend verification" later).
export async function sendEmail({ to, subject, html }: SendEmailInput): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[email:dev] to=${to} subject="${subject}"\n${html}\n`);
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('sendEmail: Resend request failed', res.status, body);
    }
  } catch (err) {
    console.error('sendEmail: request threw', err);
  }
}

// Shared shell so every transactional email looks consistent. Table-based layout
// (not flexbox/div-only) deliberately — Outlook's rendering engine (Word-based) ignores
// most modern CSS, and <table role="presentation"> is the one layout primitive every
// mail client (Gmail, Outlook, Apple Mail, Hotmail) renders the same way. Card-on-gray
// background + colored header bar + footer with real Privacy/Terms links, matching the
// look of mainstream transactional email (Stripe/ESET/etc.) rather than a bare paragraph.
function emailShell(bodyHtml: string): string {
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
          <td dir="rtl" style="padding: 36px 32px 8px; text-align: right; color: #1c1917;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td dir="rtl" style="background: #fafaf9; padding: 20px 32px; text-align: right; border-top: 1px solid #e7e5e4;">
            <div style="font-size: 12px; color: #78716c;">
              <a href="https://macrocore.io/privacy" style="color: #78716c; text-decoration: underline;">سياسة الخصوصية</a>
              &nbsp;·&nbsp;
              <a href="https://macrocore.io/terms" style="color: #78716c; text-decoration: underline;">الشروط والأحكام</a>
            </div>
            <div style="font-size: 11px; color: #a8a29e; margin-top: 10px;">© 2026 macrocore.io — الكويت. جميع الحقوق محفوظة.</div>
          </td>
        </tr>
      </table>
    </div>
  `;
}

// Reusable CTA button + "didn't work? paste this link" fallback — real ESP templates
// always include the raw URL as plain text too, since some clients strip <a> styling
// or block the click entirely.
function ctaButton(link: string, label: string): string {
  return `
    <div style="text-align: center; margin: 28px 0;">
      <a href="${link}" style="display: inline-block; background: #f59e0b; color: #ffffff; text-decoration: none; padding: 14px 40px; border-radius: 10px; font-weight: 700; font-size: 15px;">${label}</a>
    </div>
    <p style="font-size: 12px; color: #a8a29e; line-height: 1.7;">إذا لم يعمل الزر، انسخ الرابط التالي والصقه في المتصفح:<br><a href="${link}" style="color: #b45309; word-break: break-all;">${link}</a></p>
  `;
}

export function verificationEmailHtml(link: string): string {
  return emailShell(`
    <p style="font-size: 15px; margin: 0 0 4px;">أهلاً بك 👋</p>
    <p style="font-size: 14px; line-height: 1.8; color: #44403c;">شكراً لتسجيلك في macrocore. اضغط الزر أدناه لتفعيل بريدك الإلكتروني وإتمام إعداد حسابك:</p>
    ${ctaButton(link, 'تفعيل البريد الإلكتروني')}
    <p style="font-size: 12px; color: #a8a29e; border-top: 1px solid #f5f5f4; padding-top: 16px;">هذا الرابط صالح لمدة 24 ساعة. إذا لم تُنشئ حساباً بـ macrocore، بإمكانك تجاهل هذه الرسالة بأمان.</p>
  `);
}

export function passwordResetEmailHtml(link: string): string {
  return emailShell(`
    <p style="font-size: 15px; margin: 0 0 4px;">أهلاً 👋</p>
    <p style="font-size: 14px; line-height: 1.8; color: #44403c;">وصلنا طلب لإعادة تعيين كلمة مرور حسابك في macrocore. اضغط الزر أدناه لتعيين كلمة مرور جديدة:</p>
    ${ctaButton(link, 'إعادة تعيين كلمة المرور')}
    <p style="font-size: 12px; color: #a8a29e; border-top: 1px solid #f5f5f4; padding-top: 16px;">هذا الرابط صالح لمدة 30 دقيقة فقط. إذا لم تطلب هذا، تجاهل هذه الرسالة — كلمة مرورك لن تتغير.</p>
  `);
}
