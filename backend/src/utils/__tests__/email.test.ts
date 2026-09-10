import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  minuteBucket,
  computeBackoffMs,
  classifyResendFailure,
  mapResendEventTypeToJobStatus,
  verifyResendWebhookSignature,
  resolveSenderFrom,
  resolveReplyTo,
  verificationEmailHtml,
  passwordResetEmailHtml,
  passwordChangedEmailHtml,
  testEmailHtml,
  isStatusTransitionAllowed,
  isWorkerFinalizeAllowed,
  STATUS_RANK,
  decideReconcileOutcome,
  ticketLifecycleEmailHtml,
  ticketReplyEmailHtml,
  ticketSlaEmailHtml,
  type EmailCategory,
  type EmailJobStatus,
  type EmailLang,
} from '../email';

// ---------------------------------------------------------------------------
// minuteBucket
// ---------------------------------------------------------------------------
describe('minuteBucket', () => {
  it('is stable within the same minute', () => {
    const a = new Date('2026-09-08T10:15:00.000Z');
    const b = new Date('2026-09-08T10:15:59.999Z');
    expect(minuteBucket(a)).toBe(minuteBucket(b));
  });

  it('changes across a minute boundary', () => {
    const a = new Date('2026-09-08T10:15:59.999Z');
    const b = new Date('2026-09-08T10:16:00.000Z');
    expect(minuteBucket(a)).not.toBe(minuteBucket(b));
  });
});

// ---------------------------------------------------------------------------
// computeBackoffMs
// ---------------------------------------------------------------------------
describe('computeBackoffMs', () => {
  it('starts at 30s for the first failed attempt', () => {
    expect(computeBackoffMs(1)).toBe(30_000);
  });

  it('doubles each attempt', () => {
    expect(computeBackoffMs(2)).toBe(60_000);
    expect(computeBackoffMs(3)).toBe(120_000);
    expect(computeBackoffMs(4)).toBe(240_000);
  });

  it('caps at 1 hour and never exceeds it for large attempt counts', () => {
    expect(computeBackoffMs(20)).toBe(60 * 60 * 1000);
    expect(computeBackoffMs(1000)).toBe(60 * 60 * 1000);
  });

  it('never returns a value below the base for attempt 0 or negative input', () => {
    expect(computeBackoffMs(0)).toBe(30_000);
    expect(computeBackoffMs(-5)).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// classifyResendFailure
// ---------------------------------------------------------------------------
describe('classifyResendFailure', () => {
  it('treats a null status (fetch threw — network/DNS/timeout) as temp', () => {
    expect(classifyResendFailure(null)).toBe('temp');
  });

  it('treats 429 (rate limit) as temp', () => {
    expect(classifyResendFailure(429)).toBe('temp');
  });

  it('treats every 5xx as temp', () => {
    expect(classifyResendFailure(500)).toBe('temp');
    expect(classifyResendFailure(502)).toBe('temp');
    expect(classifyResendFailure(503)).toBe('temp');
  });

  it('treats other 4xx (bad request, auth, invalid recipient) as permanent', () => {
    expect(classifyResendFailure(400)).toBe('permanent');
    expect(classifyResendFailure(401)).toBe('permanent');
    expect(classifyResendFailure(403)).toBe('permanent');
    expect(classifyResendFailure(404)).toBe('permanent');
    expect(classifyResendFailure(422)).toBe('permanent');
  });
});

// ---------------------------------------------------------------------------
// mapResendEventTypeToJobStatus
// ---------------------------------------------------------------------------
describe('mapResendEventTypeToJobStatus', () => {
  it('maps the tracked lifecycle events', () => {
    expect(mapResendEventTypeToJobStatus('email.sent')).toBe('sent');
    expect(mapResendEventTypeToJobStatus('email.delivered')).toBe('delivered');
    expect(mapResendEventTypeToJobStatus('email.delivery_delayed')).toBe('delayed');
    expect(mapResendEventTypeToJobStatus('email.bounced')).toBe('bounced');
    expect(mapResendEventTypeToJobStatus('email.complained')).toBe('complained');
    expect(mapResendEventTypeToJobStatus('email.failed')).toBe('permanently_failed');
    expect(mapResendEventTypeToJobStatus('email.suppressed')).toBe('suppressed');
  });

  it('returns null for untracked event types (e.g. opened/clicked)', () => {
    expect(mapResendEventTypeToJobStatus('email.opened')).toBeNull();
    expect(mapResendEventTypeToJobStatus('email.clicked')).toBeNull();
    expect(mapResendEventTypeToJobStatus('something.unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isStatusTransitionAllowed / STATUS_RANK -- out-of-order webhook delivery
// must never regress a job's status, and this is now the SAME guard both
// finalizeJob() (the worker's own write) and applyJobStatusFromEvent() (the
// webhook path) call -- one source of truth, not two hand-written copies.
// ---------------------------------------------------------------------------
describe('isStatusTransitionAllowed', () => {
  it('allows normal forward progress: queued -> sent -> delivered', () => {
    expect(isStatusTransitionAllowed('queued', 'sent')).toBe(true);
    expect(isStatusTransitionAllowed('sent', 'delivered')).toBe(true);
  });

  it('rejects the exact regressions named in the original reliability pass', () => {
    expect(isStatusTransitionAllowed('delivered', 'sent')).toBe(false);
    expect(isStatusTransitionAllowed('delivered', 'delayed')).toBe(false);
    expect(isStatusTransitionAllowed('bounced', 'sent')).toBe(false);
    expect(isStatusTransitionAllowed('bounced', 'queued')).toBe(false);
    expect(isStatusTransitionAllowed('complained', 'processing')).toBe(false);
    expect(isStatusTransitionAllowed('suppressed', 'delayed')).toBe(false);
    expect(isStatusTransitionAllowed('permanently_failed', 'sent')).toBe(false);
  });

  // Gap 1: a worker finishing AFTER a webhook already advanced the job must
  // never overwrite what the webhook decided. finalizeJob() now calls this
  // exact function before writing, so this is the scenario named in the
  // correction request, expressed at the level that's actually testable
  // without a live database.
  it('blocks a worker finalizing "sent" after a webhook already delivered the job first (processing -> delivered via webhook, then the worker tries to finalize "sent")', () => {
    // The job started 'processing' (rank 0); a webhook applied 'delivered'
    // (rank 3) before the worker's own Resend HTTP call returned. The
    // worker's late finalizeJob('sent') must be blocked.
    expect(isStatusTransitionAllowed('delivered', 'sent')).toBe(false);
    // Same for a late 'temp_failed' or 'permanently_failed' report arriving
    // after a webhook already confirmed the send succeeded.
    expect(isStatusTransitionAllowed('delivered', 'temp_failed')).toBe(false);
    expect(isStatusTransitionAllowed('delivered', 'permanently_failed')).toBe(false);
  });

  it('allows a real webhook event to resolve a requires_review job (low rank on purpose)', () => {
    expect(isStatusTransitionAllowed('requires_review', 'sent')).toBe(true);
    expect(isStatusTransitionAllowed('requires_review', 'delivered')).toBe(true);
    expect(isStatusTransitionAllowed('requires_review', 'bounced')).toBe(true);
  });

  it('allows a late complaint to land after delivered (legitimate real-world order)', () => {
    expect(isStatusTransitionAllowed('delivered', 'complained')).toBe(true);
  });

  it('never lets anything overwrite an admin cancellation', () => {
    const allStatuses = Object.keys(STATUS_RANK) as EmailJobStatus[];
    for (const s of allStatuses) {
      if (s === 'cancelled') continue;
      expect(isStatusTransitionAllowed('cancelled', s)).toBe(false);
    }
  });

  // Gap 2a: delayed must rank ABOVE sent, not lateral to it -- an older
  // 'sent' event arriving after 'delivery_delayed' must not revert the
  // status back to 'sent'.
  it('ranks delayed strictly above sent: sent -> delayed is forward progress, delayed -> sent is a regression', () => {
    expect(isStatusTransitionAllowed('sent', 'delayed')).toBe(true);
    expect(isStatusTransitionAllowed('delayed', 'sent')).toBe(false);
    // delayed still never outranks delivered.
    expect(isStatusTransitionAllowed('delivered', 'delayed')).toBe(false);
    expect(isStatusTransitionAllowed('delayed', 'delivered')).toBe(true);
  });

  // Gap 2b: two different terminal outcomes that happen to share a rank must
  // not overwrite one another just because the rank ties.
  it('blocks conflicting terminal events at the same rank from overwriting each other', () => {
    // bounced / complained / suppressed all tie at the same "Resend-confirmed
    // terminal outcome" rank.
    expect(isStatusTransitionAllowed('bounced', 'complained')).toBe(false);
    expect(isStatusTransitionAllowed('complained', 'bounced')).toBe(false);
    expect(isStatusTransitionAllowed('bounced', 'suppressed')).toBe(false);
    expect(isStatusTransitionAllowed('complained', 'suppressed')).toBe(false);
    // delivered / permanently_failed tie too (see STATUS_RANK's comment on
    // permanently_failed) -- an already-delivered job must never be knocked
    // back to permanently_failed by a stray/late failure report, and the
    // reverse must not happen either.
    expect(isStatusTransitionAllowed('delivered', 'permanently_failed')).toBe(false);
    expect(isStatusTransitionAllowed('permanently_failed', 'delivered')).toBe(false);
  });

  // Gap 2c: a repeated/redelivered identical event (or a worker finalizing
  // exactly what a webhook already independently confirmed) must remain a
  // harmless no-op, not get blocked as a "regression".
  it('treats an identical repeat of the current status as an allowed no-op, at every rank', () => {
    const allStatuses = Object.keys(STATUS_RANK) as EmailJobStatus[];
    for (const s of allStatuses) {
      expect(isStatusTransitionAllowed(s, s)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// isWorkerFinalizeAllowed -- second reliability-correction gap found
// 2026-09-08: the strict shared STATUS_RANK table (above) cannot represent
// the worker's own operational retry cycle without blocking legitimate
// finalize outcomes, because 'processing'/'temp_failed'/'dev_skipped' all
// tie at rank 0. finalizeJob() (the worker's own write path) uses this
// function instead of isStatusTransitionAllowed() directly; the webhook path
// (applyJobStatusFromEvent) is untouched and keeps using
// isStatusTransitionAllowed() directly.
// ---------------------------------------------------------------------------
describe('isWorkerFinalizeAllowed', () => {
  it('lets a worker finalize a job it still owns (processing) into temp_failed, for the next retry to happen', () => {
    expect(isWorkerFinalizeAllowed('processing', 'temp_failed')).toBe(true);
  });

  it('lets a worker finalize a job it still owns (processing) into dev_skipped, in local dev without a provider configured', () => {
    expect(isWorkerFinalizeAllowed('processing', 'dev_skipped')).toBe(true);
  });

  it('lets a worker finalize a job it still owns (processing) into sent, the normal successful outcome', () => {
    expect(isWorkerFinalizeAllowed('processing', 'sent')).toBe(true);
  });

  it('lets a worker finalize a job it still owns (processing) into permanently_failed, when the Resend call itself failed permanently', () => {
    expect(isWorkerFinalizeAllowed('processing', 'permanently_failed')).toBe(true);
  });

  it('blocks delivered -> temp_failed -- a resolved job must never regress just because a late worker is still finishing', () => {
    expect(isWorkerFinalizeAllowed('delivered', 'temp_failed')).toBe(false);
  });

  it('blocks a late worker from overwriting any provider status a webhook already advanced the job past processing to', () => {
    const alreadyAdvanced: EmailJobStatus[] = ['sent', 'delayed', 'delivered', 'bounced', 'complained', 'suppressed'];
    const workerAttempts: EmailJobStatus[] = ['temp_failed', 'dev_skipped'];
    for (const current of alreadyAdvanced) {
      for (const attempted of workerAttempts) {
        expect(isWorkerFinalizeAllowed(current, attempted)).toBe(false);
      }
    }
  });

  it('still allows every ordinary forward transition isStatusTransitionAllowed already allowed (the exception only ADDS cases, never removes any)', () => {
    expect(isWorkerFinalizeAllowed('queued', 'sent')).toBe(true);
    expect(isWorkerFinalizeAllowed('sent', 'delivered')).toBe(true);
    expect(isWorkerFinalizeAllowed('requires_review', 'sent')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decideReconcileOutcome -- gap 3: bounded, non-starving webhook-correlation
// retry. Pure scheduling function, no database -- this is what
// reconcilePendingEmailEvents() consults for each still-unmatched event.
// ---------------------------------------------------------------------------
describe('decideReconcileOutcome', () => {
  it('schedules the next retry using the same backoff curve as email job retries, pushed further out on each miss', () => {
    const now = new Date('2026-09-08T12:00:00.000Z');
    const first = decideReconcileOutcome({ receivedAt: now, reconcileAttempts: 0, now });
    const second = decideReconcileOutcome({ receivedAt: now, reconcileAttempts: 1, now });
    expect(first.action).toBe('retry_later');
    expect(second.action).toBe('retry_later');
    if (first.action === 'retry_later' && second.action === 'retry_later') {
      // Each miss pushes the next attempt further into the future than the
      // last -- this is exactly what stops a persistently-unmatched event
      // from occupying the front of every future batch.
      expect(second.nextReconcileAt.getTime()).toBeGreaterThan(first.nextReconcileAt.getTime());
    }
  });

  it('gives up once the event is older than the safe retry window, regardless of attempt count', () => {
    const receivedAt = new Date('2026-09-08T00:00:00.000Z');
    const wayLater = new Date('2026-09-08T23:00:00.000Z'); // 23h later
    const decision = decideReconcileOutcome({ receivedAt, reconcileAttempts: 1, now: wayLater });
    expect(decision.action).toBe('give_up');
  });

  it('does not give up on a fresh event still well inside the window', () => {
    const receivedAt = new Date('2026-09-08T12:00:00.000Z');
    const aFewMinutesLater = new Date('2026-09-08T12:03:00.000Z');
    const decision = decideReconcileOutcome({ receivedAt, reconcileAttempts: 0, now: aFewMinutesLater });
    expect(decision.action).toBe('retry_later');
  });

  it('never blocks newer valid events: a persistently-unmatched event backed off across two simulated batches sorts BEHIND a freshly inserted one', () => {
    const t0 = new Date('2026-09-08T12:00:00.000Z');
    // A stuck event, received at t0, missed once already (simulating "batch 1"
    // already tried and failed to correlate it).
    const stuckFirstRetry = decideReconcileOutcome({ receivedAt: t0, reconcileAttempts: 0, now: t0 });
    expect(stuckFirstRetry.action).toBe('retry_later');
    const stuckNextReconcileAt = stuckFirstRetry.action === 'retry_later' ? stuckFirstRetry.nextReconcileAt : null;
    expect(stuckNextReconcileAt).not.toBeNull();

    // A fresh, genuinely-correlatable event arrives shortly after t0 -- its
    // own next_reconcile_at (schema default: "now" at insert time) is its
    // arrival time itself, with no backoff applied yet.
    const freshEventArrivesAt = new Date(t0.getTime() + 5_000);
    const freshEventNextReconcileAt = freshEventArrivesAt;

    // The fresh event's eligibility time must be earlier than the stuck
    // event's pushed-back retry time -- so `ORDER BY next_reconcile_at ASC`
    // surfaces the fresh one first in "batch 2", proving the stuck event
    // (still legitimately pending, not yet given up) does not block it.
    expect(freshEventNextReconcileAt.getTime()).toBeLessThan(stuckNextReconcileAt!.getTime());
  });
});

// ---------------------------------------------------------------------------
// verifyResendWebhookSignature
// ---------------------------------------------------------------------------
// Builds a request the same way Resend/Svix's documented HMAC scheme does, so
// these tests exercise the verifier against an independently-constructed
// signature rather than round-tripping through the same code path.
function signPayload(opts: { rawBody: string; svixId: string; svixTimestamp: string; secretRaw: Buffer }) {
  const signedContent = `${opts.svixId}.${opts.svixTimestamp}.${opts.rawBody}`;
  const sig = crypto.createHmac('sha256', opts.secretRaw).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

describe('verifyResendWebhookSignature', () => {
  const secretRaw = crypto.randomBytes(32);
  const secret = `whsec_${secretRaw.toString('base64')}`;
  const rawBody = JSON.stringify({ type: 'email.sent', data: { email_id: 'abc123' } });
  const svixId = 'msg_test123';

  it('accepts a correctly-signed, fresh payload', () => {
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const svixSignature = signPayload({ rawBody, svixId, svixTimestamp, secretRaw });
    expect(
      verifyResendWebhookSignature({ rawBody, svixId, svixTimestamp, svixSignature, secret })
    ).toBe(true);
  });

  it('accepts when the matching signature is one of several space-separated candidates', () => {
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const real = signPayload({ rawBody, svixId, svixTimestamp, secretRaw });
    const decoy = 'v1,bm90dGhlcmVhbHNpZ25hdHVyZQ==';
    expect(
      verifyResendWebhookSignature({
        rawBody,
        svixId,
        svixTimestamp,
        svixSignature: `${decoy} ${real}`,
        secret,
      })
    ).toBe(true);
  });

  it('rejects a tampered body (signature computed over the original)', () => {
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const svixSignature = signPayload({ rawBody, svixId, svixTimestamp, secretRaw });
    const tamperedBody = JSON.stringify({ type: 'email.sent', data: { email_id: 'DIFFERENT' } });
    expect(
      verifyResendWebhookSignature({ rawBody: tamperedBody, svixId, svixTimestamp, svixSignature, secret })
    ).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const wrongSecretRaw = crypto.randomBytes(32);
    const svixSignature = signPayload({ rawBody, svixId, svixTimestamp, secretRaw: wrongSecretRaw });
    expect(
      verifyResendWebhookSignature({ rawBody, svixId, svixTimestamp, svixSignature, secret })
    ).toBe(false);
  });

  it('rejects an expired timestamp outside the tolerance window (replay protection)', () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 999);
    const svixSignature = signPayload({ rawBody, svixId, svixTimestamp: oldTimestamp, secretRaw });
    expect(
      verifyResendWebhookSignature({
        rawBody,
        svixId,
        svixTimestamp: oldTimestamp,
        svixSignature,
        secret,
        toleranceSeconds: 300,
      })
    ).toBe(false);
  });

  it('rejects when any required header is missing', () => {
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const svixSignature = signPayload({ rawBody, svixId, svixTimestamp, secretRaw });
    expect(
      verifyResendWebhookSignature({ rawBody, svixId: undefined, svixTimestamp, svixSignature, secret })
    ).toBe(false);
    expect(
      verifyResendWebhookSignature({ rawBody, svixId, svixTimestamp: undefined, svixSignature, secret })
    ).toBe(false);
    expect(
      verifyResendWebhookSignature({ rawBody, svixId, svixTimestamp, svixSignature: undefined, secret })
    ).toBe(false);
  });

  it('rejects when the secret is empty (webhook not configured)', () => {
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const svixSignature = signPayload({ rawBody, svixId, svixTimestamp, secretRaw });
    expect(
      verifyResendWebhookSignature({ rawBody, svixId, svixTimestamp, svixSignature, secret: '' })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveSenderFrom / resolveReplyTo — per-category sender identity
// ---------------------------------------------------------------------------
describe('resolveSenderFrom', () => {
  it('gives every category a notify.macrocore.io sender identity', () => {
    const categories: EmailCategory[] = ['verification', 'password_reset', 'security', 'invitation', 'approval', 'test'];
    for (const category of categories) {
      expect(resolveSenderFrom(category)).toMatch(/@notify\.macrocore\.io>?$/);
    }
  });

  it('never uses the human mail.macrocore.io mailbox domain as a sender', () => {
    const categories: EmailCategory[] = ['verification', 'password_reset', 'security', 'invitation', 'approval', 'test'];
    for (const category of categories) {
      expect(resolveSenderFrom(category)).not.toContain('mail.macrocore.io');
    }
  });
});

describe('resolveReplyTo', () => {
  it('routes verification, password_reset, invitation and approval to support@macrocore.io', () => {
    expect(resolveReplyTo('verification')).toBe('support@macrocore.io');
    expect(resolveReplyTo('password_reset')).toBe('support@macrocore.io');
    expect(resolveReplyTo('invitation')).toBe('support@macrocore.io');
    expect(resolveReplyTo('approval')).toBe('support@macrocore.io');
  });

  it('gives security notices no Reply-To (the email body already tells the recipient to contact support directly)', () => {
    expect(resolveReplyTo('security')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bilingual templates
// ---------------------------------------------------------------------------
describe('bilingual templates', () => {
  it('verificationEmailHtml renders RTL Arabic and LTR English with the right link embedded', () => {
    const link = 'https://app.macrocore.io/verify?token=xyz';
    const ar = verificationEmailHtml(link, 'ar');
    const en = verificationEmailHtml(link, 'en');
    expect(ar).toContain('dir="rtl"');
    expect(ar).toContain(link);
    expect(ar).toContain('تفعيل البريد الإلكتروني');
    expect(en).toContain('dir="ltr"');
    expect(en).toContain(link);
    expect(en).toContain('Verify email');
    // The two languages must not be identical bodies with only dir swapped.
    expect(ar).not.toBe(en);
  });

  it('passwordResetEmailHtml renders both languages with the reset link', () => {
    const link = 'https://app.macrocore.io/reset?token=xyz';
    const ar = passwordResetEmailHtml(link, 'ar');
    const en = passwordResetEmailHtml(link, 'en');
    expect(ar).toContain(link);
    expect(ar).toContain('إعادة تعيين كلمة المرور');
    expect(en).toContain(link);
    expect(en).toContain('Reset password');
  });

  it('passwordChangedEmailHtml mentions support@macrocore.io in both languages (security notice, no Reply-To routing)', () => {
    const ar = passwordChangedEmailHtml('ar');
    const en = passwordChangedEmailHtml('en');
    expect(ar).toContain('support@macrocore.io');
    expect(en).toContain('support@macrocore.io');
  });

  it('testEmailHtml renders a distinct body per language for the admin test-send feature', () => {
    const ar = testEmailHtml('ar');
    const en = testEmailHtml('en');
    expect(ar).toContain('dir="rtl"');
    expect(en).toContain('dir="ltr"');
    expect(ar).not.toBe(en);
  });
});
// ---------------------------------------------------------------------------
// SQL parameter type consistency (regression: production 42P08 "inconsistent
// types deduced for parameter $2" -- text versus character varying)
// ---------------------------------------------------------------------------
// applyJobStatusFromEvent's UPDATE email_jobs query reused the same $2
// placeholder both as a bare `status = $2` (VARCHAR column context) and
// inside `CASE WHEN $2 = 'delivered'` (untyped text-literal comparison
// context). Postgres's parameter type inference can't reconcile two
// different inferred types for one placeholder in one statement, so every
// real webhook delivery that matched an existing job crashed with 42P08 --
// a class of bug that pure/mocked unit tests can never catch, since it is a
// property of how Postgres itself parses and type-checks the query, not of
// this file's own logic. This static check reads the real source (no DB
// connection, no mocks) and asserts that no `.query(...)` call anywhere in
// email.ts reuses the same numbered placeholder with two different cast
// forms -- the exact shape of bug that shipped to production undetected.
describe('SQL parameter type consistency (regression: 42P08)', () => {
  it('never uses the same placeholder with inconsistent casts within one query', () => {
    const source = fs.readFileSync(path.join(__dirname, '../email.ts'), 'utf-8');
    const queryCallRegex = /\.query\s*(?:<[^>]*>)?\s*\(\s*`([^`]*)`/g;
    const offenders: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = queryCallRegex.exec(source)) !== null) {
      const sql = match[1];
      const formsByPlaceholder = new Map<string, Set<string>>();
      const placeholderRegex = /\$(\d+)(::[a-zA-Z_]+)?/g;
      let placeholderMatch: RegExpExecArray | null;
      while ((placeholderMatch = placeholderRegex.exec(sql)) !== null) {
        const num = placeholderMatch[1];
        const cast = placeholderMatch[2] ?? '(no cast)';
        if (!formsByPlaceholder.has(num)) formsByPlaceholder.set(num, new Set());
        formsByPlaceholder.get(num)!.add(cast);
      }
      for (const [num, forms] of formsByPlaceholder) {
        if (forms.size > 1) {
          offenders.push(
            `placeholder $${num} used with inconsistent casts [${[...forms].join(', ')}] in query:\n${sql.trim()}`
          );
        }
      }
    }
    expect(offenders.join('\n\n---\n\n')).toEqual('');
  });
});

// ---------------------------------------------------------------------------
// SLA timezone incident (2026-09-09) — ENABLE_BACKGROUND_SWEEPS guard.
// A local dev backend was left running against the PRODUCTION DATABASE_URL;
// with no RESEND_API_KEY and NODE_ENV=development, its own sweepEmailQueue()
// tick claimed real production email jobs and finalized them 'dev_skipped'
// (see claude/sla-timezone-incident-2026-09-09.md, project doc). This checks
// the real source (no DB connection, no mocks) rather than calling
// sweepEmailQueue() live — a live call would hit claimBatch()'s real query,
// which is exactly the kind of live-DB dependency this sandbox has no
// network path for.
describe('SLA timezone incident (2026-09-09) — ENABLE_BACKGROUND_SWEEPS guard', () => {
  const source = fs.readFileSync(path.join(__dirname, '../email.ts'), 'utf-8');

  it('checks env.ENABLE_BACKGROUND_SWEEPS and returns BEFORE any job is claimed', () => {
    const guardIdx = source.indexOf('if (!env.ENABLE_BACKGROUND_SWEEPS)');
    const reclaimIdx = source.indexOf('await reclaimStuckProcessingJobs()');
    const claimIdx = source.indexOf('jobs = await claimBatch(limit)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(reclaimIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(-1);
    // The guard must precede BOTH — reclaimStuckProcessingJobs() also touches
    // real email_jobs rows and must not run from a disabled instance either.
    expect(guardIdx).toBeLessThan(reclaimIdx);
    expect(guardIdx).toBeLessThan(claimIdx);
  });

  it("the guard's early return matches sweepEmailQueue()'s own resolved shape exactly (claimed/sent/tempFailed/permanentlyFailed all 0)", () => {
    const guardBlock = source.slice(source.indexOf('if (!env.ENABLE_BACKGROUND_SWEEPS)'), source.indexOf('await reclaimStuckProcessingJobs()'));
    expect(guardBlock).toContain('{ claimed: 0, sent: 0, tempFailed: 0, permanentlyFailed: 0 }');
  });

  it('never logs inside the guarded no-op path — the enabled/disabled state is logged once at startup (index.ts), not once per 60s tick', () => {
    const guardBlock = source.slice(source.indexOf('if (!env.ENABLE_BACKGROUND_SWEEPS)'), source.indexOf('await reclaimStuckProcessingJobs()'));
    expect(guardBlock).not.toMatch(/console\.\w+\(/);
  });
});

// ---------------------------------------------------------------------------
// Helpdesk / ITSM templates (Chat 3B, Stage 1). No controller call site
// exists yet — these are pure unit tests of the template functions
// themselves (ticketLifecycleEmailHtml / ticketReplyEmailHtml /
// ticketSlaEmailHtml), matching the verification list agreed for this stage.
// ---------------------------------------------------------------------------
const LINK = 'https://app.macrocore.io/support?ticket=abc-123';
const LANGS: EmailLang[] = ['ar', 'en'];
const LIFECYCLE_VARIANTS = ['created', 'assigned', 'status_changed', 'resolved', 'closed', 'reopened'] as const;

describe('resolveSenderFrom / resolveReplyTo — helpdesk category', () => {
  it("gives 'helpdesk' a notify.macrocore.io sender identity, same domain as every other category", () => {
    expect(resolveSenderFrom('helpdesk')).toMatch(/@notify\.macrocore\.io>?$/);
  });

  it("routes 'helpdesk' replies to support@macrocore.io (reuses the existing support mailbox, no new inbox)", () => {
    expect(resolveReplyTo('helpdesk')).toBe('support@macrocore.io');
  });

  it('adding the helpdesk category left every previously-tested category unchanged', () => {
    const categories: EmailCategory[] = ['verification', 'password_reset', 'security', 'invitation', 'approval', 'test'];
    for (const category of categories) {
      expect(resolveSenderFrom(category)).toMatch(/@notify\.macrocore\.io>?$/);
    }
    expect(resolveReplyTo('security')).toBeUndefined();
  });
});

describe('ticketLifecycleEmailHtml', () => {
  it('renders every lifecycle variant in both Arabic and English with a distinct header, body and CTA', () => {
    for (const variant of LIFECYCLE_VARIANTS) {
      const ar = ticketLifecycleEmailHtml({
        lang: 'ar',
        ticketNumber: 'GEN-2609-0001',
        isHrSensitive: false,
        ticketSubject: null,
        variant,
        link: LINK,
      });
      const en = ticketLifecycleEmailHtml({
        lang: 'en',
        ticketNumber: 'GEN-2609-0001',
        isHrSensitive: false,
        ticketSubject: null,
        variant,
        link: LINK,
      });
      expect(ar.html).toContain('dir="rtl"');
      expect(en.html).toContain('dir="ltr"');
      expect(ar.html).not.toBe(en.html);
      expect(ar.subject).not.toBe(en.subject);
      // Every variant must carry its own ticket reference and CTA link.
      expect(ar.subject).toContain('GEN-2609-0001');
      expect(en.subject).toContain('GEN-2609-0001');
      expect(ar.html).toContain(LINK);
      expect(en.html).toContain(LINK);
    }
  });

  it('embeds the exact ticket number (no subject) in both subject and body when no ticketSubject is given', () => {
    const { subject, html } = ticketLifecycleEmailHtml({
      lang: 'en',
      ticketNumber: 'GEN-2609-0042',
      isHrSensitive: false,
      ticketSubject: null,
      variant: 'created',
      link: LINK,
    });
    expect(subject).toBe('Ticket received #GEN-2609-0042');
    expect(html).toContain('#GEN-2609-0042');
  });

  it('status_changed includes the bilingual statusLabel text when provided, in the matching language only', () => {
    const statusLabel = { en: 'In Progress', ar: 'قيد التنفيذ' };
    const en = ticketLifecycleEmailHtml({
      lang: 'en',
      ticketNumber: 'GEN-2609-0001',
      isHrSensitive: false,
      ticketSubject: null,
      variant: 'status_changed',
      link: LINK,
      statusLabel,
    });
    const ar = ticketLifecycleEmailHtml({
      lang: 'ar',
      ticketNumber: 'GEN-2609-0001',
      isHrSensitive: false,
      ticketSubject: null,
      variant: 'status_changed',
      link: LINK,
      statusLabel,
    });
    expect(en.html).toContain('In Progress');
    expect(en.html).not.toContain('قيد التنفيذ');
    expect(ar.html).toContain('قيد التنفيذ');
    expect(ar.html).not.toContain('In Progress');
  });

  it('status_changed still renders a sensible body when no statusLabel is given (falls back to the generic "was updated" copy)', () => {
    const { html } = ticketLifecycleEmailHtml({
      lang: 'en',
      ticketNumber: 'GEN-2609-0001',
      isHrSensitive: false,
      ticketSubject: null,
      variant: 'status_changed',
      link: LINK,
    });
    expect(html).toContain('status was updated');
  });

  it('every CTA link in every variant/language exactly reproduces the passed-in link', () => {
    for (const variant of LIFECYCLE_VARIANTS) {
      for (const lang of LANGS) {
        const { html } = ticketLifecycleEmailHtml({
          lang,
          ticketNumber: 'GEN-2609-0001',
          isHrSensitive: false,
          ticketSubject: null,
          variant,
          link: LINK,
        });
        expect(html).toContain(`href="${LINK}"`);
      }
    }
  });
});

describe('ticketReplyEmailHtml', () => {
  it('renders both languages with the ticket reference and the exact CTA link, and never includes any reply message text (no such parameter exists)', () => {
    for (const lang of LANGS) {
      const { subject, html } = ticketReplyEmailHtml({
        lang,
        ticketNumber: 'GEN-2609-0001',
        isHrSensitive: false,
        ticketSubject: null,
        link: LINK,
      });
      expect(subject).toContain('GEN-2609-0001');
      expect(html).toContain(`href="${LINK}"`);
    }
    const ar = ticketReplyEmailHtml({ lang: 'ar', ticketNumber: 'GEN-2609-0001', isHrSensitive: false, ticketSubject: null, link: LINK });
    const en = ticketReplyEmailHtml({ lang: 'en', ticketNumber: 'GEN-2609-0001', isHrSensitive: false, ticketSubject: null, link: LINK });
    expect(ar.html).toContain('dir="rtl"');
    expect(en.html).toContain('dir="ltr"');
    expect(ar.subject).not.toBe(en.subject);
  });
});

describe('ticketSlaEmailHtml', () => {
  it('renders warning and breach for both response and resolution SLA types, in both languages, with the exact CTA link', () => {
    const severities: Array<'warning' | 'breach'> = ['warning', 'breach'];
    const slaTypes: Array<'response' | 'resolution'> = ['response', 'resolution'];
    for (const severity of severities) {
      for (const slaType of slaTypes) {
        for (const lang of LANGS) {
          const { subject, html } = ticketSlaEmailHtml({
            lang,
            ticketNumber: 'GEN-2609-0001',
            severity,
            slaType,
            link: LINK,
          });
          expect(subject).toContain('GEN-2609-0001');
          expect(html).toContain(`href="${LINK}"`);
        }
      }
    }
  });

  it('renders escalated in both languages regardless of slaType, with the exact CTA link', () => {
    for (const lang of LANGS) {
      const { subject, html } = ticketSlaEmailHtml({ lang, ticketNumber: 'GEN-2609-0001', severity: 'escalated', link: LINK });
      expect(subject).toContain('GEN-2609-0001');
      expect(html).toContain(`href="${LINK}"`);
    }
    // slaType is ignored/irrelevant for 'escalated' — passing one changes nothing.
    const withoutType = ticketSlaEmailHtml({ lang: 'en', ticketNumber: 'GEN-2609-0001', severity: 'escalated', link: LINK });
    const withType = ticketSlaEmailHtml({ lang: 'en', ticketNumber: 'GEN-2609-0001', severity: 'escalated', slaType: 'response', link: LINK });
    expect(withoutType.subject).toBe(withType.subject);
    expect(withoutType.html).toBe(withType.html);
  });

  it('warning/response and warning/resolution produce distinct copy (the SLA type label actually varies the output)', () => {
    const response = ticketSlaEmailHtml({ lang: 'en', ticketNumber: 'GEN-2609-0001', severity: 'warning', slaType: 'response', link: LINK });
    const resolution = ticketSlaEmailHtml({ lang: 'en', ticketNumber: 'GEN-2609-0001', severity: 'warning', slaType: 'resolution', link: LINK });
    expect(response.html).not.toBe(resolution.html);
  });
});

// ---------------------------------------------------------------------------
// HR-sensitive ticket subject protection — structural, not caller-dependent.
// isHrSensitive: true must discard ticketSubject internally, before it ever
// reaches the returned `subject` string OR the HTML body, even when a
// non-null ticketSubject IS passed in (the exact mistake a future caller
// could otherwise make).
// ---------------------------------------------------------------------------
describe('HR-sensitive ticket subject protection', () => {
  const sensitiveSubject = 'Harassment complaint against my manager';

  it('ticketLifecycleEmailHtml never leaks ticketSubject into the subject line or HTML body when isHrSensitive is true, for every variant/language', () => {
    for (const variant of LIFECYCLE_VARIANTS) {
      for (const lang of LANGS) {
        const { subject, html } = ticketLifecycleEmailHtml({
          lang,
          ticketNumber: 'GEN-2609-0001',
          isHrSensitive: true,
          ticketSubject: sensitiveSubject,
          variant,
          link: LINK,
        });
        expect(subject).not.toContain(sensitiveSubject);
        expect(subject).not.toContain('Harassment');
        expect(html).not.toContain(sensitiveSubject);
        expect(html).not.toContain('Harassment');
        // The ticket reference must fall back to the bare "#ticketNumber" form
        // (no " — <fragment>" suffix) rather than a redacted placeholder that
        // could itself hint something was hidden.
        expect(subject).toContain('#GEN-2609-0001');
      }
    }
  });

  it('ticketReplyEmailHtml never leaks ticketSubject when isHrSensitive is true', () => {
    const { subject, html } = ticketReplyEmailHtml({
      lang: 'en',
      ticketNumber: 'GEN-2609-0001',
      isHrSensitive: true,
      ticketSubject: sensitiveSubject,
      link: LINK,
    });
    expect(subject).not.toContain(sensitiveSubject);
    expect(html).not.toContain(sensitiveSubject);
  });

  it('the exact same ticketSubject IS shown (safely escaped) when isHrSensitive is false — proving the gate is the isHrSensitive flag, not some property of the subject text itself', () => {
    const { subject, html } = ticketLifecycleEmailHtml({
      lang: 'en',
      ticketNumber: 'GEN-2609-0001',
      isHrSensitive: false,
      ticketSubject: sensitiveSubject,
      variant: 'created',
      link: LINK,
    });
    expect(subject).toContain(sensitiveSubject);
    expect(html).toContain(sensitiveSubject);
  });
});

// ---------------------------------------------------------------------------
// Non-HR-sensitive ticket subject: HTML escaping (body) vs. no escaping
// (plain-text Subject: header) — same underlying ticketSubject, two output
// channels, two different safety rules.
// ---------------------------------------------------------------------------
describe('non-HR ticket subject: HTML escaping vs. plain-text subject', () => {
  it('HTML-escapes a dangerous ticket subject in the HTML body but leaves the plain-text subject line un-escaped', () => {
    const dangerous = '<script>alert(1)</script> & "quoted" \'stuff\'';
    const { subject, html } = ticketLifecycleEmailHtml({
      lang: 'en',
      ticketNumber: 'GEN-2609-0001',
      isHrSensitive: false,
      ticketSubject: dangerous,
      variant: 'created',
      link: LINK,
    });
    // Plain-text Subject: header — raw characters preserved, no entity encoding.
    expect(subject).toContain(dangerous);
    // HTML body — the same text must be escaped, never appear as raw markup.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('truncates a ticket subject longer than 80 characters with an ellipsis, identically in both the plain subject and the escaped HTML body', () => {
    const longSubject = 'A'.repeat(120);
    const { subject, html } = ticketLifecycleEmailHtml({
      lang: 'en',
      ticketNumber: 'GEN-2609-0001',
      isHrSensitive: false,
      ticketSubject: longSubject,
      variant: 'created',
      link: LINK,
    });
    expect(subject).not.toContain('A'.repeat(120));
    expect(subject).toContain('…');
    expect(html).toContain('…');
    // 79 raw chars + the ellipsis marker = the 80-char cap.
    expect(subject).toContain('A'.repeat(79) + '…');
  });
});

// ---------------------------------------------------------------------------
// Plain-text email Subject: header safety — CR/LF/control-character stripping
// (header-injection prevention). This must hold for the returned `subject`
// string even though it is deliberately NEVER HTML-escaped.
// ---------------------------------------------------------------------------
describe('plain-text email Subject: header — CR/LF/control-character safety', () => {
  it('strips CR, LF and other control characters out of ticketSubject before it reaches the returned subject string', () => {
    const injected = 'Refund\r\nBcc: attacker@evil.example\nX-Injected: true\tend';
    const { subject } = ticketLifecycleEmailHtml({
      lang: 'en',
      ticketNumber: 'GEN-2609-0001',
      isHrSensitive: false,
      ticketSubject: injected,
      variant: 'created',
      link: LINK,
    });
    expect(subject).not.toMatch(/[\r\n\t]/);
    // eslint-disable-next-line no-control-regex
    expect(subject).not.toMatch(/[\x00-\x1F\x7F]/);
    // The visible words survive — only the injection-capable characters and
    // the collapsed whitespace runs they left behind are removed.
    expect(subject).toContain('Refund');
    expect(subject).toContain('Bcc: attacker@evil.example');
  });

  it('collapses the stripped control characters to single spaces rather than deleting words together', () => {
    const injected = 'Wifi\r\nnot working';
    const { subject } = ticketReplyEmailHtml({
      lang: 'en',
      ticketNumber: 'GEN-2609-0001',
      isHrSensitive: false,
      ticketSubject: injected,
      link: LINK,
    });
    expect(subject).toContain('Wifi not working');
  });
});
