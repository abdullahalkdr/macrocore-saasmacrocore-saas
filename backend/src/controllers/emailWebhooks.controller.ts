import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { env } from '../config/env';
import { verifyResendWebhookSignature, recordAndApplyWebhookEvent } from '../utils/email';

// POST /api/webhooks/resend — public, no requireAuth (Resend/Svix calls this
// server-to-server, it can't carry a Macrocore session JWT). Authenticity is
// verified via the Svix HMAC signature instead — see
// utils/email.ts's verifyResendWebhookSignature. Never accepts an
// unauthenticated request that could manipulate a delivery record.
//
// Idempotent by svix-id (email_events.svix_id UNIQUE, MIGRATION_076) — Resend/
// Svix's own documented behavior is to retry a webhook delivery on anything
// but a fast 2xx, so the exact same event can and will arrive more than once
// in normal operation; this must be a no-op the second time, not a duplicate
// state transition.
export const handleResendWebhook = asyncHandler(async (req: Request, res: Response) => {
  if (!env.RESEND_WEBHOOK_SECRET) {
    // Refuse outright rather than silently accept — an unset secret in
    // production would otherwise be a silent trust hole (anyone could POST a
    // fake "delivered" event), not a dev convenience like the send-side
    // RESEND_API_KEY fallback.
    res.status(503).json({ success: false, message: 'Webhook not configured' });
    return;
  }

  const svixId = req.header('svix-id');
  const svixTimestamp = req.header('svix-timestamp');
  const svixSignature = req.header('svix-signature');
  // app.ts's express.json({ verify }) captured the exact bytes Resend sent —
  // re-serializing req.body (different key order/whitespace) would produce a
  // different signature and always fail verification, so this must use the
  // untouched raw buffer, never JSON.stringify(req.body).
  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';

  const valid = verifyResendWebhookSignature({
    rawBody,
    svixId: svixId ?? undefined,
    svixTimestamp: svixTimestamp ?? undefined,
    svixSignature: svixSignature ?? undefined,
    secret: env.RESEND_WEBHOOK_SECRET,
  });
  if (!valid || !svixId) {
    res.status(401).json({ success: false, message: 'Invalid signature' });
    return;
  }

  const payload = (req.body ?? {}) as { type?: unknown; data?: { email_id?: unknown } };
  const eventType = typeof payload.type === 'string' ? payload.type : 'unknown';
  const resendMessageId = typeof payload.data?.email_id === 'string' ? payload.data.email_id : null;

  // Recording the event and applying its effect to the matching email_jobs row
  // happens atomically inside one DB transaction (see
  // utils/email.ts's recordAndApplyWebhookEvent) — including the out-of-order-
  // delivery guard (a status can never regress) and the race where this
  // webhook arrives before the job row's resend_message_id is written yet
  // (handled by the periodic reconcile sweep, never dropped).
  const outcome = await recordAndApplyWebhookEvent({
    svixId,
    eventType,
    resendMessageId,
    payload,
  });

  // Every outcome here is a 200 — 'duplicate', 'pending_correlation' and
  // 'ignored_event_type' are all legitimate, already-handled cases, not
  // errors; returning anything but 2xx would make Resend/Svix keep retrying a
  // webhook that was already processed correctly.
  res.status(200).json({ success: true, outcome });
});
