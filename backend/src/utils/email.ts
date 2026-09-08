import crypto from 'crypto';
import { pool } from '../db/pool';
import { env } from '../config/env';

export type EmailLang = 'ar' | 'en';

// Every transactional category this app sends. Chat 2 (Helpdesk/SLA) and
// Chat 3 (Billing/Subscriptions) extend this union and CATEGORY_FROM below when
// they add their own categories — never invent a second sender-identity or
// queue mechanism, this one is meant to be shared.
export type EmailCategory = 'verification' | 'password_reset' | 'security' | 'invitation' | 'approval' | 'test';

export type EmailJobStatus =
  | 'queued'
  | 'processing'
  | 'sent'
  | 'delivered'
  | 'delayed'
  | 'temp_failed'
  | 'permanently_failed'
  | 'bounced'
  | 'complained'
  | 'suppressed'
  | 'cancelled'
  | 'dev_skipped'
  // A job reclaimed after an apparent backend crash mid-delivery, past the
  // point a same-Idempotency-Key retry can be proven safe (see
  // reclaimStuckProcessingJobs()). Never auto-retried — an admin reviews it
  // (checking Resend's own dashboard for whether it actually sent) before
  // manually retrying via the admin UI.
  | 'requires_review';

export interface EmailJobRow {
  id: string;
  company_id: string | null;
  category: EmailCategory;
  dedup_key: string;
  recipient_email: string;
  lang: EmailLang;
  subject: string;
  html: string;
  reply_to: string | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  status: EmailJobStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  resend_message_id: string | null;
  last_error: string | null;
  last_attempted_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

// Sender identities under the notify.macrocore.io subdomain — DECIDED in the
// email rollout brief (Section 3), not open for re-evaluation here. These are
// sender-only Resend identities, never cPanel mailboxes — they never receive
// mail, only need Resend's domain authentication (SPF/DKIM) on
// notify.macrocore.io. This is now the ONLY place a "from" address is decided —
// there is deliberately no per-deploy env var for it (there used to be an
// EMAIL_FROM env var; removed, see claude/resend-setup-checklist.md's 2026-09-08
// revision — a single flat sender was a Phase-1-draft placeholder, not a real
// config knob once per-category identities were decided).
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

export function resolveSenderFrom(category: EmailCategory): string {
  return CATEGORY_FROM[category];
}

export function resolveReplyTo(category: EmailCategory): string | undefined {
  return CATEGORY_REPLY_TO[category];
}

// Coarse per-minute time bucket — used by call sites (resendVerification,
// forgotPassword) to build a dedup_key that absorbs a rapid double-click or a
// retried HTTP request within the same minute as one job, without blocking a
// legitimate second request a few minutes later. Exported as its own pure
// function so it's unit-testable without a database.
export function minuteBucket(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 60_000);
}

// Exponential backoff for temp_failed retries: 30s, 60s, 120s, 240s, 480s...
// capped at 1 hour. attemptCount is the attempt that JUST happened (1-indexed —
// claimJobById increments it before this is ever consulted), so attempt 1's
// failure schedules the 2nd attempt 30s out.
export function computeBackoffMs(attemptCount: number): number {
  const base = 30_000;
  const capped = base * Math.pow(2, Math.max(0, attemptCount - 1));
  return Math.min(capped, 60 * 60 * 1000);
}

// Classifies a Resend HTTP failure so deliverClaimedJob() knows whether to
// retry (temp) or give up immediately (permanent) regardless of remaining
// attempt budget. A null status means the fetch() itself threw (network error,
// DNS failure, timeout) — always temp, never the email's fault.
export function classifyResendFailure(httpStatus: number | null): 'temp' | 'permanent' {
  if (httpStatus === null) return 'temp';
  if (httpStatus === 429) return 'temp';
  if (httpStatus >= 500) return 'temp';
  // 400/401/403/404/422 etc — malformed request, bad/unverified sender domain,
  // invalid API key, invalid recipient address. None of these fix themselves on
  // a bare retry; a human needs to act (fix the key, verify the domain, correct
  // the address) — an admin can still explicitly retry once that's done, via
  // the admin retry endpoint, which resets attempt_count.
  return 'permanent';
}

// Maps a Resend/Svix webhook event `type` to the email_jobs status it implies.
// Event types Macrocore doesn't track in this lifecycle (opened/clicked — no
// product need for those yet) return null; the webhook handler still records
// the raw event in email_events for audit but leaves the job's status alone.
export function mapResendEventTypeToJobStatus(eventType: string): EmailJobStatus | null {
  switch (eventType) {
    case 'email.sent':
      return 'sent';
    case 'email.delivered':
      return 'delivered';
    case 'email.delivery_delayed':
      return 'delayed';
    case 'email.bounced':
      return 'bounced';
    case 'email.complained':
      return 'complained';
    // Resend-side terminal failure (rejected/undeliverable at the provider,
    // distinct from OUR OWN classifyResendFailure()'s permanent/temp split on
    // the initial API response) — same terminal weight as a bounce.
    case 'email.failed':
      return 'permanently_failed';
    case 'email.suppressed':
      return 'suppressed';
    default:
      return null;
  }
}

// Monotonic lifecycle guard applied by EVERY writer of email_jobs.status —
// both the worker's own finalization path (finalizeJob, below) and every
// webhook-driven update (applyJobStatusFromEvent, further down). Resend/Svix
// does NOT guarantee webhook delivery order, AND a webhook can genuinely
// arrive and apply before the worker's own HTTP call to Resend even returns
// (deliverClaimedJob() calling finalizeJob() afterwards must not then
// overwrite what the webhook already decided) — so this single function is
// the one source of truth both paths call, never two hand-written copies of
// the same rule that could drift apart.
//
// Rank reflects how final/advanced a state is, never chronological
// likelihood. A transition is only ever applied if it's STRICTLY forward
// (new rank > current rank) — equal rank is allowed ONLY when the status is
// literally unchanged (a redelivered/duplicate event, a harmless no-op).
// Two different statuses that happen to share a rank (e.g. bounced vs.
// complained) must never overwrite one another just because they tie —
// each terminal outcome is a distinct fact, not interchangeable with another
// at the same tier. Exported and pure so it's directly unit-testable without
// a database.
export const STATUS_RANK: Record<EmailJobStatus, number> = {
  dev_skipped: 0,
  // Deliberately LOW, not high — a real webhook event should be able to
  // resolve an ambiguous "needs manual review" job automatically once it
  // arrives (e.g. it turns out the original attempt really did reach Resend),
  // rather than being blocked from ever updating it.
  requires_review: 0,
  queued: 0,
  processing: 0,
  temp_failed: 0,
  sent: 1,
  // Ranked ABOVE sent, not lateral to it: 'delivery_delayed' only ever fires
  // after Resend has already accepted/attempted the send, so it represents
  // more progress than a bare 'sent'. This is also what makes an out-of-order
  // 'sent' event arriving AFTER a 'delayed' one a no-op instead of a
  // regression (delayed -> sent is blocked; sent -> delayed still allowed).
  delayed: 2,
  delivered: 3,
  // Ties with delivered, deliberately NOT with bounced/complained/suppressed:
  // permanently_failed can mean two different things depending on who wrote
  // it -- deliverClaimedJob()'s own "the Resend API call itself failed"
  // classification (always from a rank-0 state, no resend_message_id ever
  // gets set on that path, so a webhook can never reach it anyway), or the
  // 'email.failed' webhook event applied to a job that already has a
  // resend_message_id (i.e. was already 'sent'/'delayed'). In that second,
  // webhook-reachable case it is a resolved outcome exactly like 'delivered'
  // is -- and the two must not be able to overwrite one another (an already-
  // delivered job must never be knocked back to permanently_failed by a
  // stray/late failure report, which is what tying it to delivered's rank
  // enforces via the equal-rank guard above), while still being reachable as
  // forward progress from 'sent'/'delayed' like 'delivered' itself is.
  permanently_failed: 3,
  bounced: 4,
  complained: 4,
  suppressed: 4,
  // An admin's own explicit action (not currently wired to any UI action, but
  // reserved) — ranked above everything so no automatic event ever overwrites it.
  cancelled: 5,
};

export function isStatusTransitionAllowed(current: EmailJobStatus, next: EmailJobStatus): boolean {
  // A repeat of the exact same status (redelivered webhook, or a worker
  // finalizing what a webhook already independently confirmed) is always a
  // harmless no-op, regardless of rank.
  if (current === next) return true;
  // Otherwise, only strictly forward progress is allowed — this is what
  // stops two different terminal outcomes at the same rank (bounced vs.
  // complained, say) from overwriting each other.
  return STATUS_RANK[next] > STATUS_RANK[current];
}

// STATUS_RANK/isStatusTransitionAllowed above models ONE axis: how far a
// message has progressed through actual provider delivery. It deliberately
// ties 'processing', 'temp_failed', 'dev_skipped', 'requires_review' and
// 'queued' at the bottom, because none of those represents more delivery
// progress than another. But a worker finalizing a job it still owns
// (status is still literally 'processing' -- nothing, including no webhook,
// has moved it anywhere else yet) is a SECOND, different axis: its own
// operational retry cycle. 'processing' -> 'temp_failed' (so the next
// attempt can retry) and 'processing' -> 'dev_skipped' (no provider
// configured) are normal, expected, everyday outcomes of that attempt, not
// a regression -- but they were being blocked because they tie for rank
// with 'processing' itself under the strict-forward-progress rule.
//
// Rather than force one shared total rank to model both axes at once (that
// is exactly what produced the earlier permanently_failed/delivered ranking
// bug), this is kept as a small, explicit, narrow exception used ONLY by
// the worker's own finalize path below -- the webhook path
// (applyJobStatusFromEvent) keeps calling isStatusTransitionAllowed()
// directly and is completely unaffected: a webhook event is never mapped to
// 'temp_failed' or 'dev_skipped' in the first place (see
// mapResendEventTypeToJobStatus), so it never needed this exception, and a
// late worker still can never overwrite anything once the job has moved
// past 'processing' -- the exception only fires while current === 'processing'.
const WORKER_FINALIZE_OUTCOMES = new Set<EmailJobStatus>(['sent', 'temp_failed', 'permanently_failed', 'dev_skipped']);

export function isWorkerFinalizeAllowed(current: EmailJobStatus, next: EmailJobStatus): boolean {
  if (isStatusTransitionAllowed(current, next)) return true;
  return current === 'processing' && WORKER_FINALIZE_OUTCOMES.has(next);
}

// Verifies a Resend webhook request using Svix's documented HMAC scheme (Resend
// delivers webhooks via Svix — https://docs.svix.com/receiving/verifying-payloads/how).
// Implemented directly against Node's crypto rather than pulling in the `svix`
// package — same reasoning utils/email.ts's Resend send call already uses ("no
// SDK dependency for one endpoint"): this is one well-documented HMAC check, not
// worth a new dependency for. Pure function, no I/O — unit-testable with a
// hand-built signature.
export function verifyResendWebhookSignature(params: {
  rawBody: string;
  svixId: string | undefined;
  svixTimestamp: string | undefined;
  svixSignature: string | undefined;
  secret: string;
  toleranceSeconds?: number;
  now?: Date;
}): boolean {
  const { rawBody, svixId, svixTimestamp, svixSignature, secret, toleranceSeconds = 300, now = new Date() } = params;
  if (!secret || !svixId || !svixTimestamp || !svixSignature) return false;

  const ts = parseInt(svixTimestamp, 10);
  if (!Number.isFinite(ts)) return false;
  // Replay protection — a captured-and-replayed request is rejected once it's
  // older than the tolerance window, independent of signature validity.
  if (Math.abs(Math.floor(now.getTime() / 1000) - ts) > toleranceSeconds) return false;

  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  } catch {
    return false;
  }

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  // expected is itself a base64 STRING (digest('base64')) — must decode it back to raw
  // bytes with Buffer.from(expected, 'base64') before comparing to the also-decoded
  // sigBuf below. Buffer.from(expected) alone (no encoding arg) defaults to utf8 and
  // would compare the wrong thing (44 ASCII bytes of the base64 text vs. a 32-byte
  // HMAC digest) — every signature would fail length-check and this function would
  // always return false. Caught by this file's own webhook-signature unit tests.
  const expectedBuf = Buffer.from(expected, 'base64');

  // svix-signature can carry multiple space-separated "v1,<sig>" candidates
  // (key rotation) — a match against any one of them is valid.
  const candidates = svixSignature.split(' ').map((s) => s.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const [version, sig] = candidate.split(',');
    if (version !== 'v1' || !sig) continue;
    try {
      const sigBuf = Buffer.from(sig, 'base64');
      if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

interface EnqueueEmailInput {
  to: string;
  subject: string;
  html: string;
  category: EmailCategory;
  lang: EmailLang;
  // Stable per business event — see MIGRATION_076's own comment on
  // email_jobs.dedup_key. Required, not optional: every call site is forced to
  // think about what makes this event unique.
  dedupKey: string;
  companyId?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
}

// Unique-ish per backend process, purely for the claimed_by observability
// column (which worker/instance last touched a row) — not itself a safety
// mechanism, the atomic status-guarded UPDATE is.
const WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

async function claimJobById(jobId: string): Promise<EmailJobRow | null> {
  const result = await pool.query<EmailJobRow>(
    `UPDATE email_jobs
     SET status = 'processing', claimed_at = now(), claimed_by = $2,
         attempt_count = attempt_count + 1, last_attempted_at = now(), updated_at = now()
     WHERE id = $1 AND status IN ('queued', 'temp_failed') AND next_attempt_at <= now()
     RETURNING *`,
    [jobId, WORKER_ID]
  );
  return result.rows[0] ?? null;
}

// Batch claim for the periodic sweep — FOR UPDATE SKIP LOCKED inside the CTE is
// the standard Postgres safe-multi-consumer-queue pattern: two backend
// instances (or two overlapping sweep ticks) racing this at the same moment
// simply split the available rows between them, never double-claim one.
async function claimBatch(limit: number): Promise<EmailJobRow[]> {
  const result = await pool.query<EmailJobRow>(
    `WITH claimed AS (
       SELECT id FROM email_jobs
       WHERE status IN ('queued', 'temp_failed') AND next_attempt_at <= now()
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE email_jobs e
     SET status = 'processing', claimed_at = now(), claimed_by = $2,
         attempt_count = attempt_count + 1, last_attempted_at = now(), updated_at = now()
     FROM claimed c
     WHERE e.id = c.id
     RETURNING e.*`,
    [limit, WORKER_ID]
  );
  return result.rows;
}

// The worker's own status write -- and, same as the webhook path
// (applyJobStatusFromEvent below), guarded by isStatusTransitionAllowed()
// rather than writing unconditionally. Resend's own webhook can arrive and
// apply (e.g. straight to 'delivered') BEFORE this function's caller
// (deliverClaimedJob) even gets its HTTP response back from Resend -- without
// this guard, a worker finishing "late" would silently overwrite a job that
// a webhook already advanced further (e.g. stamping 'sent' back over an
// already-'delivered' row). SELECT ... FOR UPDATE + conditional UPDATE inside
// one transaction is the exact same locking shape applyJobStatusFromEvent
// uses, so a concurrent webhook and a concurrent finalize on the same row
// simply serialize on the row lock -- never a lost update, never a deadlock
// (only ever one row locked at a time, no cross-lock ordering).
async function finalizeJob(
  jobId: string,
  patch: { status: EmailJobStatus; resendMessageId?: string | null; error?: string | null; nextAttemptAt?: Date | null; sentAt?: Date | null }
): Promise<EmailJobStatus> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ status: EmailJobStatus }>('SELECT status FROM email_jobs WHERE id = $1 FOR UPDATE', [jobId]);
    const currentStatus = current.rows[0]?.status;
    if (!currentStatus || !isWorkerFinalizeAllowed(currentStatus, patch.status)) {
      if (currentStatus) {
        console.log(
          `[email] finalizeJob: blocked ${currentStatus} -> ${patch.status} for job ${jobId} (already advanced further, e.g. by a webhook that beat this worker to it)`
        );
      }
      await client.query('ROLLBACK');
      // Callers (deliverClaimedJob) count/report outcomes off this return
      // value — when the write is blocked, what actually persisted is
      // whatever was already there, NOT the status this call attempted, so
      // metrics must reflect the former, never the latter.
      return currentStatus ?? patch.status;
    }
    await client.query(
      `UPDATE email_jobs
       SET status = $2, resend_message_id = COALESCE($3, resend_message_id), last_error = $4,
           next_attempt_at = COALESCE($5, next_attempt_at), sent_at = COALESCE($6, sent_at), updated_at = now()
       WHERE id = $1`,
      [jobId, patch.status, patch.resendMessageId ?? null, patch.error ?? null, patch.nextAttemptAt ?? null, patch.sentAt ?? null]
    );
    await client.query('COMMIT');
    return patch.status;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Finite timeout on the Resend call itself — a hung request (Resend never
// responding) must enter the existing retry flow via the catch block below,
// not leave the job stuck in 'processing' indefinitely. This is the backstop
// for a slow/hanging REQUEST; reclaimStuckProcessingJobs() below is the
// separate backstop for a hard PROCESS crash (this timeout can't help with
// that — there's no process left to fire it).
const RESEND_REQUEST_TIMEOUT_MS = 15_000;

// Does the actual Resend call for an already-claimed (status='processing') job
// and resolves it to a terminal-for-this-attempt state. Never throws — every
// branch, including the dev-mode and network-error paths, ends in a
// finalizeJob() call so a job can never be stuck silently in 'processing'
// because of an uncaught exception here.
async function deliverClaimedJob(job: EmailJobRow): Promise<EmailJobStatus> {
  if (!env.RESEND_API_KEY) {
    if (env.NODE_ENV === 'production') {
      // Missing config in production is NOT the same as local dev without a
      // provider configured — it must be loud and visible (a real customer
      // email is being silently dropped), and must NOT be recorded as
      // 'dev_skipped', which reads in the admin log as an intentional no-op.
      // permanently_failed surfaces it in the delivery log and makes it
      // retryable (via the admin retry button) the moment the key is fixed.
      console.error(
        `[email:CONFIG ERROR] RESEND_API_KEY is not set in production — job ${job.id} (category=${job.category}, to=${job.recipient_email}) cannot be sent. Set RESEND_API_KEY in Railway.`
      );
      // Return what finalizeJob actually persisted, not the attempted status
      // — a webhook could in principle have already resolved this job (e.g.
      // it was reclaimed and a stray late webhook landed first), in which
      // case the real outcome is that status, not 'permanently_failed'.
      return await finalizeJob(job.id, { status: 'permanently_failed', error: 'CONFIG ERROR: RESEND_API_KEY is not set in production.' });
    }
    // Harmless local-dev / pre-verification fallback, unchanged.
    console.log(`[email:dev] category=${job.category} to=${job.recipient_email} subject="${job.subject}"\n${job.html}\n`);
    return await finalizeJob(job.id, { status: 'dev_skipped' });
  }

  let httpStatus: number | null = null;
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), RESEND_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        // Resend's own documented idempotency mechanism (Idempotency-Key header,
        // 24h retention). This job's own id is a stable identifier that never
        // changes across retries — so if a retry (whether the immediate
        // best-effort one, a backoff retry, or a reclaimStuckProcessingJobs()
        // crash-recovery retry) reaches Resend again for a request that
        // actually already succeeded, Resend returns the ORIGINAL result
        // instead of sending a second copy. See IDEMPOTENCY_SAFE_WINDOW_MS on
        // reclaimStuckProcessingJobs() for how that 24h window is respected.
        'Idempotency-Key': job.id,
      },
      body: JSON.stringify({
        from: resolveSenderFrom(job.category),
        to: job.recipient_email,
        subject: job.subject,
        html: job.html,
        ...(job.reply_to ? { reply_to: job.reply_to } : {}),
      }),
      signal: abortController.signal,
    });
    httpStatus = res.status;

    if (res.ok) {
      const json = (await res.json().catch(() => null)) as { id?: string } | null;
      return await finalizeJob(job.id, { status: 'sent', resendMessageId: json?.id ?? null, sentAt: new Date() });
    }

    const bodyText = await res.text().catch(() => '');
    const classification = classifyResendFailure(httpStatus);
    if (classification === 'permanent' || job.attempt_count >= job.max_attempts) {
      return await finalizeJob(job.id, { status: 'permanently_failed', error: `HTTP ${httpStatus}: ${bodyText.slice(0, 500)}` });
    }
    const backoffMs = computeBackoffMs(job.attempt_count);
    return await finalizeJob(job.id, {
      status: 'temp_failed',
      error: `HTTP ${httpStatus}: ${bodyText.slice(0, 500)}`,
      nextAttemptAt: new Date(Date.now() + backoffMs),
    });
  } catch (err) {
    // fetch() itself threw — network/DNS error, or our own abort() firing after
    // RESEND_REQUEST_TIMEOUT_MS (err.name === 'AbortError'). Always temp: none
    // of these mean Resend rejected the email, they mean we don't know what
    // happened, and the Idempotency-Key above makes a retry safe either way.
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `Resend request timed out after ${RESEND_REQUEST_TIMEOUT_MS}ms`
          : err.message
        : String(err);
    if (job.attempt_count >= job.max_attempts) {
      return await finalizeJob(job.id, { status: 'permanently_failed', error: message });
    }
    const backoffMs = computeBackoffMs(job.attempt_count);
    return await finalizeJob(job.id, { status: 'temp_failed', error: message, nextAttemptAt: new Date(Date.now() + backoffMs) });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// Creates a durable job row and returns immediately — this is the "durable
// delivery" half of the contract: the row exists (and is safely queryable/
// retryable) the moment this resolves, regardless of whether Resend, the
// network, or this very process is available a second later. Callers await
// this (it's a fast single INSERT), but do NOT need to await actual delivery —
// the immediate best-effort attempt below is fire-and-forget, and the periodic
// sweep is the crash-safety net if this process dies before that attempt
// finishes.
//
// dedup_key is UNIQUE — ON CONFLICT DO NOTHING makes a duplicate enqueue of the
// same business event a true no-op (no new row, no new send), whether the
// duplicate came from a retried HTTP request, a double form submit, or the
// same scheduler tick running twice.
//
// Never throws: if email_jobs itself can't be written to (migration not run
// yet, DB unreachable), the business action that called this must still
// succeed — same contract the pre-existing sendEmail() always had.
export async function enqueueEmail(input: EnqueueEmailInput): Promise<{ jobId: string | null; deduped: boolean }> {
  try {
    const insertResult = await pool.query<{ id: string }>(
      `INSERT INTO email_jobs (company_id, category, dedup_key, recipient_email, lang, subject, html, reply_to, related_entity_type, related_entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING id`,
      [
        input.companyId ?? null,
        input.category,
        input.dedupKey,
        input.to,
        input.lang,
        input.subject,
        input.html,
        resolveReplyTo(input.category) ?? null,
        input.relatedEntityType ?? null,
        input.relatedEntityId ?? null,
      ]
    );

    if (insertResult.rows[0]) {
      const jobId = insertResult.rows[0].id;
      void attemptDeliverNow(jobId).catch((err) => console.error('[email] immediate delivery attempt failed', jobId, err));
      return { jobId, deduped: false };
    }

    const existing = await pool.query<{ id: string }>('SELECT id FROM email_jobs WHERE dedup_key = $1', [input.dedupKey]);
    return { jobId: existing.rows[0]?.id ?? null, deduped: true };
  } catch (err) {
    console.error('[email] enqueueEmail failed — the triggering business action still succeeded', err);
    return { jobId: null, deduped: false };
  }
}

// Best-effort immediate attempt right after enqueue, for low user-facing
// latency (a verification email that shows up in seconds, not on the next
// sweep tick). If the row was already claimed by something else (the sweep
// beat this to it, or it's not in a claimable state for any reason),
// claimJobById() simply returns null and this is a silent no-op — the sweep
// remains the source of truth either way.
export async function attemptDeliverNow(jobId: string): Promise<void> {
  const job = await claimJobById(jobId);
  if (!job) return;
  await deliverClaimedJob(job);
}

// Crash recovery for jobs left in 'processing' by a backend that died (or was
// redeployed) mid-attempt — a hung REQUEST already times out and finalizes
// itself via RESEND_REQUEST_TIMEOUT_MS above; this is for when the PROCESS
// itself is gone, so nothing was left to run that timeout. Uses the same
// FOR UPDATE SKIP LOCKED claim-batch pattern as claimBatch() for multi-instance
// safety.
const PROCESSING_STUCK_MS = 5 * 60 * 1000; // 5 min — comfortably longer than
// RESEND_REQUEST_TIMEOUT_MS plus time to finalize, so a job still 'processing'
// past this is a crashed worker, not a slow request.
const IDEMPOTENCY_SAFE_WINDOW_MS = 20 * 60 * 60 * 1000; // 20h — a conservative
// margin under Resend's documented 24h Idempotency-Key retention
// (https://resend.com/docs — Idempotency Keys expire after 24 hours).
// Reclaiming and resending with the SAME job id as the Idempotency-Key inside
// this window is safe even if the original attempt actually reached Resend —
// Resend returns the original result instead of sending a second copy. Beyond
// this window that can no longer be proven, so the job is flagged
// 'requires_review' instead of auto-retried.

export async function reclaimStuckProcessingJobs(limit = 50): Promise<{ requeued: number; requiresReview: number }> {
  const result = await pool.query<{ status: EmailJobStatus }>(
    `WITH stuck AS (
       SELECT id, attempt_count, max_attempts, claimed_at
       FROM email_jobs
       WHERE status = 'processing' AND claimed_at < now() - ($1::bigint * interval '1 millisecond')
       ORDER BY claimed_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE email_jobs e
     SET
       status = CASE
         WHEN (now() - stuck.claimed_at) < ($3::bigint * interval '1 millisecond') AND stuck.attempt_count < stuck.max_attempts
           THEN 'queued'
         ELSE 'requires_review'
       END,
       next_attempt_at = CASE
         WHEN (now() - stuck.claimed_at) < ($3::bigint * interval '1 millisecond') AND stuck.attempt_count < stuck.max_attempts
           THEN now()
         ELSE e.next_attempt_at
       END,
       last_error = CASE
         WHEN (now() - stuck.claimed_at) < ($3::bigint * interval '1 millisecond') AND stuck.attempt_count < stuck.max_attempts
           THEN e.last_error
         ELSE 'Reclaimed after an apparent crash mid-delivery. Safe idempotent-retry window elapsed or attempts exhausted -- check this job''s id against the Resend dashboard before retrying manually.'
       END,
       updated_at = now()
     FROM stuck
     WHERE e.id = stuck.id
     RETURNING e.status`,
    [PROCESSING_STUCK_MS, limit, IDEMPOTENCY_SAFE_WINDOW_MS]
  );
  const requeued = result.rows.filter((r) => r.status === 'queued').length;
  const requiresReview = result.rows.filter((r) => r.status === 'requires_review').length;
  if (requiresReview > 0) {
    console.error(`[email] ${requiresReview} job(s) reclaimed into requires_review after an apparent crash -- see the admin delivery log`);
  }
  return { requeued, requiresReview };
}

// Correlates one webhook event to its email_jobs row and applies the status
// transition, guarded by isStatusTransitionAllowed() so out-of-order delivery
// can never regress a job's status. Runs inside the caller's transaction (see
// recordAndApplyWebhookEvent and reconcilePendingEmailEvents) so the SELECT ...
// FOR UPDATE lock and the subsequent write are part of one atomic unit.
async function applyJobStatusFromEvent(
  client: { query: typeof pool.query },
  resendMessageId: string,
  newStatus: EmailJobStatus
): Promise<{ jobId: string } | null> {
  const jobResult = await client.query<{ id: string; status: EmailJobStatus }>(
    'SELECT id, status FROM email_jobs WHERE resend_message_id = $1 FOR UPDATE',
    [resendMessageId]
  );
  const job = jobResult.rows[0];
  if (!job) return null;
  if (isStatusTransitionAllowed(job.status, newStatus)) {
    await client.query(
      `UPDATE email_jobs
       SET status = $2::varchar,
           delivered_at = CASE WHEN $2::varchar = 'delivered' THEN now() ELSE delivered_at END,
           updated_at = now()
       WHERE id = $1`,
      [job.id, newStatus]
    );
  }
  return { jobId: job.id };
}

export type WebhookOutcome = 'duplicate' | 'applied' | 'pending_correlation' | 'ignored_event_type';

// The single entry point for POST /api/webhooks/resend (called from
// emailWebhooks.controller.ts after signature verification). Everything here
// happens inside ONE database transaction, which is what makes "recording the
// event" and "applying its effect" atomic-or-safely-repeatable: if the process
// dies before COMMIT, nothing persisted (Postgres rolls the whole transaction
// back), Resend's documented at-least-once redelivery sends the same webhook
// again later, and this function runs clean from scratch — never a half-applied
// state. If it dies AFTER commit, the event is durably recorded and the
// svix_id UNIQUE constraint makes any redelivery a true no-op.
export async function recordAndApplyWebhookEvent(input: {
  svixId: string;
  eventType: string;
  resendMessageId: string | null;
  payload: unknown;
}): Promise<WebhookOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO email_events (svix_id, event_type, resend_message_id, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (svix_id) DO NOTHING
       RETURNING id`,
      [input.svixId, input.eventType, input.resendMessageId, JSON.stringify(input.payload)]
    );
    if (!inserted.rows[0]) {
      // Already recorded this exact delivery attempt — true no-op, never touch
      // email_jobs a second time for the same svix_id.
      await client.query('ROLLBACK');
      return 'duplicate';
    }
    const eventId = inserted.rows[0].id;
    const newStatus = mapResendEventTypeToJobStatus(input.eventType);

    if (!newStatus || !input.resendMessageId) {
      // A real event type this lifecycle doesn't track (opened/clicked), or no
      // message id to correlate on — recorded for audit, nothing to apply.
      // Marked applied so the reconcile sweep never re-checks it.
      await client.query('UPDATE email_events SET applied_at = now() WHERE id = $1', [eventId]);
      await client.query('COMMIT');
      return 'ignored_event_type';
    }

    const matched = await applyJobStatusFromEvent(client, input.resendMessageId, newStatus);
    if (!matched) {
      // The webhook beat our own write of resend_message_id onto the job row
      // (deliverClaimedJob() hasn't finalized yet) -- or the id is simply
      // unknown. Leave email_job_id/applied_at NULL; reconcilePendingEmailEvents()
      // retries the correlation on every sweep tick, so the event is applied
      // once the job row catches up, never silently lost.
      await client.query('COMMIT');
      return 'pending_correlation';
    }
    // Correlation succeeded (whether or not isStatusTransitionAllowed actually
    // let the status change) -- resolved, never re-checked again.
    await client.query('UPDATE email_events SET email_job_id = $1, applied_at = now() WHERE id = $2', [matched.jobId, eventId]);
    await client.query('COMMIT');
    return 'applied';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// How long an unmatched webhook event is retried before giving up on it —
// events for another sending identity, a message id we'll simply never
// recognize, or any other genuinely orphaned delivery must not be retried
// forever. 15 minutes is generous: the legitimate race this reconcile loop
// exists for (a webhook beating our own resend_message_id write) normally
// resolves within seconds, well inside one sweep tick.
const RECONCILE_GIVE_UP_MS = 15 * 60 * 1000;

export type ReconcileOutcome =
  | { action: 'give_up' } // too old, never matched -- mark resolved-unmatched for audit
  | { action: 'retry_later'; nextReconcileAt: Date }; // push back, don't retry this tick

// Pure scheduling decision for ONE unmatched event, factored out of
// reconcilePendingEmailEvents() so it's directly unit-testable without a
// database. This is what makes the batch non-starving: reuses the exact same
// computeBackoffMs() curve email_jobs retries already use, so a
// persistently-unmatched event's next_reconcile_at gets pushed further and
// further into the future each miss -- it naturally sorts BEHIND a freshly
// inserted event (whose next_reconcile_at defaults to "now" in the schema)
// in the next tick's `ORDER BY next_reconcile_at ASC LIMIT $1` query, instead
// of permanently occupying the front of the batch and starving newer,
// genuinely-correlatable events.
export function decideReconcileOutcome(params: { receivedAt: Date; reconcileAttempts: number; now?: Date }): ReconcileOutcome {
  const now = params.now ?? new Date();
  if (now.getTime() - params.receivedAt.getTime() > RECONCILE_GIVE_UP_MS) {
    return { action: 'give_up' };
  }
  return { action: 'retry_later', nextReconcileAt: new Date(now.getTime() + computeBackoffMs(params.reconcileAttempts + 1)) };
}

// Catch-up for the race in recordAndApplyWebhookEvent() above: a webhook that
// arrived before the matching email_jobs row had its resend_message_id
// written yet. Runs on the SAME periodic sweep as the queue itself (see
// sweepEmailQueue below) -- reuses the existing timer, no second background
// system. Each pending event gets its own small transaction so one failure
// doesn't block the rest of the batch. Ordered and filtered by
// next_reconcile_at (not raw received_at) -- see decideReconcileOutcome above
// for why that's what keeps a permanently-unmatched event from blocking
// newer valid ones across multiple batches.
export async function reconcilePendingEmailEvents(limit = 50): Promise<{ reconciled: number; gaveUp: number }> {
  const pending = await pool.query<{
    id: string;
    event_type: string;
    resend_message_id: string;
    received_at: string;
    reconcile_attempts: number;
  }>(
    `SELECT id, event_type, resend_message_id, received_at, reconcile_attempts FROM email_events
     WHERE applied_at IS NULL AND resend_message_id IS NOT NULL AND next_reconcile_at <= now()
     ORDER BY next_reconcile_at ASC
     LIMIT $1`,
    [limit]
  );

  let reconciled = 0;
  let gaveUp = 0;
  for (const row of pending.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const newStatus = mapResendEventTypeToJobStatus(row.event_type);
      const matched = newStatus ? await applyJobStatusFromEvent(client, row.resend_message_id, newStatus) : null;
      if (matched) {
        await client.query('UPDATE email_events SET email_job_id = $1, applied_at = now() WHERE id = $2', [matched.jobId, row.id]);
        reconciled++;
      } else {
        const decision = decideReconcileOutcome({ receivedAt: new Date(row.received_at), reconcileAttempts: row.reconcile_attempts });
        if (decision.action === 'give_up') {
          // Never correlated to a job within the safe window -- resolve it as
          // "unmatched" for audit (applied_at set, email_job_id stays NULL is
          // how a later admin/query tells this apart from a real match) so it
          // stops being fetched by this query ever again.
          await client.query('UPDATE email_events SET applied_at = now() WHERE id = $1', [row.id]);
          console.warn(`[email] reconcilePendingEmailEvents: giving up on event ${row.id} (type=${row.event_type}) -- never correlated to a known email job`);
          gaveUp++;
        } else {
          await client.query(
            'UPDATE email_events SET reconcile_attempts = reconcile_attempts + 1, next_reconcile_at = $2 WHERE id = $1',
            [row.id, decision.nextReconcileAt]
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[email] reconcilePendingEmailEvents failed for event', row.id, err);
    } finally {
      client.release();
    }
  }
  return { reconciled, gaveUp };
}

// The crash-safety / multi-instance-safety net — call once on backend startup
// and on a periodic interval (see index.ts), and it's independently callable
// so a future Railway Cron hitting an internal endpoint can trigger it without
// any change to this function. Order matters: reclaim stuck 'processing' jobs
// and reconcile any webhook events that arrived before their job row was ready
// BEFORE claiming a fresh batch, so a job that was just reclaimed into
// 'queued' can be picked up in the same tick rather than waiting a full cycle.
export async function sweepEmailQueue(limit = 20): Promise<{ claimed: number; sent: number; tempFailed: number; permanentlyFailed: number }> {
  try {
    await reclaimStuckProcessingJobs();
  } catch (err) {
    console.error('[email] sweepEmailQueue: reclaimStuckProcessingJobs failed', err);
  }
  try {
    await reconcilePendingEmailEvents();
  } catch (err) {
    console.error('[email] sweepEmailQueue: reconcilePendingEmailEvents failed', err);
  }

  let jobs: EmailJobRow[] = [];
  try {
    jobs = await claimBatch(limit);
  } catch (err) {
    console.error('[email] sweepEmailQueue: claimBatch failed', err);
    return { claimed: 0, sent: 0, tempFailed: 0, permanentlyFailed: 0 };
  }

  let sent = 0;
  let tempFailed = 0;
  let permanentlyFailed = 0;
  for (const job of jobs) {
    const outcome = await deliverClaimedJob(job);
    if (outcome === 'sent' || outcome === 'dev_skipped') sent++;
    else if (outcome === 'temp_failed') tempFailed++;
    else if (outcome === 'permanently_failed') permanentlyFailed++;
  }
  return { claimed: jobs.length, sent, tempFailed, permanentlyFailed };
}

// Admin-initiated retry (emailAdmin.controller.ts) — resets a failed job back
// to 'queued' with a clean attempt budget. Reuses the SAME row/id (never
// inserts a new one), so the dedup_key uniqueness and the delivery-log history
// on this one job id stay intact; this is a deliberate human action, not an
// automatic retry loop, so a fresh attempt_count is appropriate here (unlike
// the automatic backoff path, which never resets it).
export async function requeueJobForRetry(jobId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE email_jobs
     SET status = 'queued', attempt_count = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
     WHERE id = $1 AND status IN ('temp_failed', 'permanently_failed', 'requires_review')
     RETURNING id`,
    [jobId]
  );
  if (result.rows.length === 0) return false;
  void attemptDeliverNow(jobId).catch((err) => console.error('[email] retry delivery attempt failed', jobId, err));
  return true;
}

// ---------------------------------------------------------------------------
// Bilingual templates
// ---------------------------------------------------------------------------

const SHELL_COPY: Record<
  EmailLang,
  { dir: 'rtl' | 'ltr'; align: 'right' | 'left'; fallbackLine: (link: string) => string; privacy: string; terms: string; footer: string }
> = {
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
// mail client (Gmail, Outlook, Apple Mail, Hotmail) renders the same way.
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

// Admin-only "send test email" (emailAdmin.controller.ts) — deliberately looks
// like a real transactional email (same shell/category='test' sender), never a
// bare "hello world", so what's being verified is the actual thing customers
// will receive.
export function testEmailHtml(lang: EmailLang): string {
  if (lang === 'en') {
    return emailShell(
      `
        <p style="font-size: 15px; margin: 0 0 4px;">Test email ✅</p>
        <p style="font-size: 14px; line-height: 1.8; color: #44403c;">This is a test message sent from macrocore's admin panel to confirm delivery is working — through the real Resend sending path, the real template shell, in English.</p>
      `,
      lang
    );
  }
  return emailShell(
    `
      <p style="font-size: 15px; margin: 0 0 4px;">رسالة اختبار ✅</p>
      <p style="font-size: 14px; line-height: 1.8; color: #44403c;">هذه رسالة اختبار مرسلة من لوحة تحكم macrocore للتأكد إن الإرسال شغال — عبر مسار Resend الحقيقي، وبنفس قالب الإيميل، باللغة العربية.</p>
    `,
    lang
  );
}
