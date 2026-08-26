// Activity Log roadmap, Phase 02 — real-time alerts, WhatsApp first (channel
// priority WhatsApp -> email -> Slack/Teams was locked by Abdullah on the roadmap
// artifact; only WhatsApp is built so far).
//
// Uses Meta's WhatsApp Cloud API directly (developers.facebook.com/docs/whatsapp/cloud-api)
// — no third-party SDK, one `fetch` call. Needs WHATSAPP_ACCESS_TOKEN and
// WHATSAPP_PHONE_NUMBER_ID as Railway environment variables on the API service.
// Abdullah has NOT set up his Meta Business Platform account yet (confirmed
// 2026-08-26), so both are unset in production today. Until they're set,
// sendWhatsAppAlert() below is a deliberate silent no-op — the rest of this
// pipeline (companies.whatsapp_alert_number / whatsapp_alerts_enabled from
// MIGRATION_068, the Settings UI, message building, and the call from
// logAudit() in this same directory) is fully wired and ready today, and goes
// live the moment both env vars are added on Railway — no code change needed.
//
// IMPORTANT for whoever adds the real credentials: Meta's Cloud API only allows
// a free-form `type: "text"` message inside a 24-hour window opened by the
// recipient messaging the business number first. A cold, business-initiated
// alert (this exact use case) technically requires a pre-approved message
// TEMPLATE instead. The simplest path once real credentials exist: have
// Abdullah message the configured WhatsApp Business number once (opens the 24h
// window — fine, since alerts go to his own operational number), or get Meta
// to approve a template and switch `type: 'text'` below to `type: 'template'`.
// Flagged here instead of guessed at — neither can be verified without a real
// Meta account.
import { pool } from '../db/pool';

const WHATSAPP_API_VERSION = 'v20.0';

export interface AlertTarget {
  type: string | null;
  label: string | null;
}

export interface FieldDiff {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

// Builds the alert body. Arabic — Abdullah reads the alert on his own phone.
export function buildSensitiveActionMessage(params: {
  action: string;
  actorLabel: string | null;
  target: AlertTarget | null;
  diffs: FieldDiff[];
}): string {
  const { action, actorLabel, target, diffs } = params;
  const lines = [
    'تنبيه — حركة حساسة بنظام macrocore',
    `العملية: ${action.replace(/_/g, ' ')}`,
    `مين سواها: ${actorLabel ?? 'غير معروف'}`,
    `طبّقت على: ${target?.label ?? 'غير معروف'}`,
  ];
  if (diffs.length > 0) {
    lines.push('التغييرات:');
    for (const d of diffs) {
      lines.push(`- ${d.field}: ${d.oldValue ?? '—'} → ${d.newValue ?? '—'}`);
    }
  }
  lines.push(`الوقت: ${new Date().toLocaleString('ar-KW')}`);
  return lines.join('\n');
}

// Fire-and-forget from logAudit() — never throws, never blocks or fails the audit
// write that already happened by the time this is called.
export async function sendWhatsAppAlert(companyId: string, message: string): Promise<void> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return; // not configured yet — see file header

  try {
    const r = await pool.query(
      'SELECT whatsapp_alert_number FROM companies WHERE id = $1 AND whatsapp_alerts_enabled = true',
      [companyId]
    );
    const to = r.rows[0]?.whatsapp_alert_number;
    if (!to) return;

    const resp = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } }),
    });
    if (!resp.ok) {
      console.error('whatsapp alert failed:', resp.status, await resp.text());
    }
  } catch (err) {
    console.error('whatsapp alert failed:', (err as Error).message);
  }
}
