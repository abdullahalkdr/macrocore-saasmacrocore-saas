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

// Shared shell so every transactional email looks consistent (same brand block header)
// without every caller re-typing the same HTML. Deliberately plain/table-free — inbox
// clients render this reliably without a templating engine.
function emailShell(bodyHtml: string): string {
  return `
    <div style="font-family: Tahoma, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1c1917;">
      <div style="font-weight: 800; font-size: 18px; color: #f59e0b; margin-bottom: 24px;">macrocore</div>
      ${bodyHtml}
      <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e7e5e4; font-size: 12px; color: #78716c;">
        macrocore.io — الكويت
      </div>
    </div>
  `;
}

export function verificationEmailHtml(link: string): string {
  return emailShell(`
    <p style="font-size: 14px; line-height: 1.7;">أهلاً بك في macrocore! اضغط الزر أدناه لتفعيل بريدك الإلكتروني:</p>
    <a href="${link}" style="display: inline-block; background: #f59e0b; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 10px; font-weight: 700; font-size: 14px; margin: 12px 0;">تفعيل البريد الإلكتروني</a>
    <p style="font-size: 12px; color: #78716c;">هذا الرابط صالح لمدة 24 ساعة. إذا لم تُنشئ حساباً بـ macrocore، تجاهل هذه الرسالة.</p>
  `);
}

export function passwordResetEmailHtml(link: string): string {
  return emailShell(`
    <p style="font-size: 14px; line-height: 1.7;">وصلنا طلب لإعادة تعيين كلمة مرور حسابك. اضغط الزر أدناه لتعيين كلمة مرور جديدة:</p>
    <a href="${link}" style="display: inline-block; background: #f59e0b; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 10px; font-weight: 700; font-size: 14px; margin: 12px 0;">إعادة تعيين كلمة المرور</a>
    <p style="font-size: 12px; color: #78716c;">هذا الرابط صالح لمدة 30 دقيقة فقط. إذا لم تطلب هذا، تجاهل هذه الرسالة — كلمة مرورك لن تتغير.</p>
  `);
}
