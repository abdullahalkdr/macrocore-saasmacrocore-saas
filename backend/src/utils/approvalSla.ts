import { pool } from '../db/pool';
import { env } from '../config/env';
import { enqueueEmail, approvalSlaReminderEmailHtml, approvalSlaBreachEmailHtml, approvalSlaDelayEmailHtml, EmailLang } from './email';
import { resolveApprovalAudience, notifyRequesterRoutingFailure, MODULE_LABEL, FINANCIAL_SLA_HOURS } from './financialApprovals';

// Phase 4 (Chat 2) — SLA reminder/breach sweep for the three single-step
// financial modules (PAYROLL/PURCHASE_ORDER/EXPENSE). Deliberately NOT
// touching ITSM_TICKET or support_tickets — see claude/phase4-sla-scope-
// decision.md (project doc): the scheduler MECHANISM is meant to be shared
// with a future Helpdesk/ITSM SLA pass, but the domain logic/state stays
// separate, and that pass hasn't started yet.
//
// Reused, not duplicated: resolveApprovalAudience() is the exact same
// eligible-approver resolution financial Approvals' in-app notifications and
// action-required/resubmit emails already use (financialApprovals.ts) — the
// email audience here can never diverge from who's actually authorized to
// act. This file adds no new authorization logic of its own.
//
// Multi-instance safety: SELECT ... FOR UPDATE SKIP LOCKED inside one
// transaction per batch — the same safe-multi-consumer pattern
// utils/email.ts's claimBatch() already uses. Holding each candidate row's
// lock for the whole time this tick evaluates it is also what satisfies
// "re-check current status before enqueueing" — no concurrent
// approve/reject/resubmit on that row can commit until this transaction
// does, so the status this tick read can't go stale mid-evaluation. On top
// of that, every actual email send is deduped at the email_jobs layer
// (dedup_key, ON CONFLICT DO NOTHING) — the true idempotency backstop if two
// instances ever did race on the same row.
const FINANCIAL_MODULE_TYPES = Object.keys(MODULE_LABEL);
const REMINDER_FRACTION = 0.75;

interface SlaCandidateRow {
  id: string;
  company_id: string;
  module_type: string;
  requester_id: string;
  request_number: string | null;
  sla_deadline_at: string;
  sla_reminder_sent_at: string | null;
  sla_breached_at: string | null;
  created_at: string;
}

async function notifyRequesterDelay(row: SlaCandidateRow, cycleKey: string): Promise<void> {
  try {
    const label = MODULE_LABEL[row.module_type];
    if (!label) return;
    const contactRes = await pool.query<{ id: string; email: string; preferred_language: EmailLang }>(
      `SELECT id, email, COALESCE(preferred_language, 'ar') AS preferred_language FROM users
       WHERE company_id = $1 AND employee_id = $2 LIMIT 1`,
      [row.company_id, row.requester_id]
    );
    const contact = contactRes.rows[0];
    if (!contact) return;

    const waitingMs = Date.now() - new Date(row.created_at).getTime();
    const waitingHours = Math.max(1, Math.round(waitingMs / (60 * 60 * 1000)));
    const waitingSinceLabel = contact.preferred_language === 'en' ? `${waitingHours}h` : `${waitingHours} ساعة`;
    const link = `${env.FRONTEND_URL}/approvals`;
    const html = approvalSlaDelayEmailHtml(contact.preferred_language, label, row.request_number ?? null, waitingSinceLabel, link);
    const subject = contact.preferred_language === 'en' ? `Your request is delayed — ${label.en}` : `طلبك تأخر — ${label.ar}`;
    await enqueueEmail({
      to: contact.email,
      subject,
      html,
      category: 'approval',
      lang: contact.preferred_language,
      dedupKey: `approval_sla_delay:${row.id}:${cycleKey}`,
      companyId: row.company_id,
      relatedEntityType: 'approval_requests',
      relatedEntityId: row.id,
    });
  } catch (err) {
    console.error('[approvalSla] failed to email requester (delay)', { requestId: row.id }, err);
  }
}

export async function sweepApprovalSla(limit = 50): Promise<{ reminded: number; breached: number; routingFailures: number }> {
  // SLA timezone incident (2026-09-09) — guard checked FIRST, before any pool
  // access, so a disabled instance never opens a client/transaction at all.
  // See claude/sla-timezone-incident-2026-09-09.md (project doc) and
  // config/env.ts's ENABLE_BACKGROUND_SWEEPS header for the full story. No
  // log line here on purpose — index.ts already logs the enabled/disabled
  // state once at startup; logging here would repeat every 60s tick.
  if (!env.ENABLE_BACKGROUND_SWEEPS) {
    return { reminded: 0, breached: 0, routingFailures: 0 };
  }
  const client = await pool.connect();
  let reminded = 0;
  let breached = 0;
  let routingFailures = 0;
  try {
    await client.query('BEGIN');

    const candidates = await client.query<SlaCandidateRow>(
      `SELECT id, company_id, module_type, requester_id, request_number, sla_deadline_at, sla_reminder_sent_at, sla_breached_at, created_at
       FROM approval_requests
       WHERE status = 'pending' AND module_type = ANY($1::text[]) AND sla_deadline_at IS NOT NULL
         AND sla_breached_at IS NULL
       ORDER BY sla_deadline_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [FINANCIAL_MODULE_TYPES, limit]
    );

    const now = Date.now();
    const windowMs = FINANCIAL_SLA_HOURS * 60 * 60 * 1000;

    for (const row of candidates.rows) {
      const label = MODULE_LABEL[row.module_type];
      if (!label) continue; // defensive — WHERE already filters to financial module types

      const deadlineMs = new Date(row.sla_deadline_at).getTime();
      const reminderAtMs = deadlineMs - windowMs * (1 - REMINDER_FRACTION);
      const cycleKey = new Date(row.sla_deadline_at).toISOString();
      const link = `${env.FRONTEND_URL}/approvals`;

      // BUGFIX (round 2, point 1) — every audience resolution below excludes the
      // requester by employee id (row.requester_id IS an employee_id — see
      // approval_requests.requester_id — the sweep never had a user id to exclude
      // by, which is exactly what excludeEmployeeId now exists for). A requester
      // who also happens to hold the module's approver permission or a
      // manager/admin role must never get their own SLA reminder/breach email.
      if (row.sla_breached_at === null && now >= deadlineMs) {
        // Breach takes priority over an unsent reminder (e.g. the sweep was
        // down across both thresholds) — only the more urgent email fires.
        //
        // BUGFIX (round 2, point 5) — sla_breached_at now records the TIMESTAMP
        // OF THE ACTUAL BREACH, not "an email was successfully delivered". It is
        // set unconditionally the moment `now >= deadlineMs`, regardless of
        // whether an eligible audience exists or any enqueueEmail() call
        // succeeds. Before this fix, a permanently unroutable request (no
        // eligible approver) left sla_breached_at NULL forever, so this branch
        // re-evaluated — and re-emailed the requester's routing-failure notice —
        // every single 60s tick, indefinitely. The requester routing-failure
        // email itself stays deduped by (requestId, cycleKey, stage), so it
        // still only ever sends once; only the row's terminal state changes.
        const audience = await resolveApprovalAudience(row.company_id, row.module_type, undefined, row.requester_id);
        if (audience.length === 0) {
          await notifyRequesterRoutingFailure(row.company_id, row.id, row.module_type, row.request_number ?? null, row.requester_id, cycleKey, 'breach');
          routingFailures++;
        } else {
          for (const member of audience) {
            const html = approvalSlaBreachEmailHtml(member.preferred_language, label, row.request_number ?? null, link);
            const subject = member.preferred_language === 'en' ? `Overdue approval — ${label.en}` : `طلب متأخر — ${label.ar}`;
            await enqueueEmail({
              to: member.email,
              subject,
              html,
              category: 'approval',
              lang: member.preferred_language,
              dedupKey: `approval_sla_breach:${row.id}:${cycleKey}:${member.id}`,
              companyId: row.company_id,
              relatedEntityType: 'approval_requests',
              relatedEntityId: row.id,
            });
          }
          await notifyRequesterDelay(row, cycleKey);
        }
        await client.query(`UPDATE approval_requests SET sla_breached_at = NOW() WHERE id = $1`, [row.id]);
        breached++;
      } else if (row.sla_breached_at === null && row.sla_reminder_sent_at === null && now >= reminderAtMs) {
        // BUGFIX (round 2, point 2) — row.sla_breached_at === null is now part
        // of this condition. Once a request is breached, no reminder may ever
        // be sent for that cycle again: without this guard, a candidate row
        // whose breach UPDATE hadn't been visible yet in some earlier
        // read — or simply one evaluated a tick late — could still fall into
        // this branch and send a "reminder" for a request that's already past
        // its deadline and already breached.
        const audience = await resolveApprovalAudience(row.company_id, row.module_type, undefined, row.requester_id);
        if (audience.length === 0) {
          await notifyRequesterRoutingFailure(row.company_id, row.id, row.module_type, row.request_number ?? null, row.requester_id, cycleKey, 'reminder');
          routingFailures++;
          continue; // sla_reminder_sent_at stays NULL — retried next tick (still pre-deadline, safe to keep retrying)
        }
        // BUGFIX (round 2, point 5) — sla_reminder_sent_at is only ever marked
        // once at least one recipient's enqueueEmail() call actually succeeded
        // (a real job created) or deduped (already delivered/queued). A tick
        // where every enqueueEmail() call fails (jobId === null, not a dedup)
        // must leave sla_reminder_sent_at NULL so the next tick retries instead
        // of silently treating a failed send as "reminder sent".
        let anySucceeded = false;
        for (const member of audience) {
          const html = approvalSlaReminderEmailHtml(member.preferred_language, label, row.request_number ?? null, link);
          const subject = member.preferred_language === 'en' ? `Reminder — ${label.en}` : `تذكير — ${label.ar}`;
          const result = await enqueueEmail({
            to: member.email,
            subject,
            html,
            category: 'approval',
            lang: member.preferred_language,
            dedupKey: `approval_sla_reminder:${row.id}:${cycleKey}:${member.id}`,
            companyId: row.company_id,
            relatedEntityType: 'approval_requests',
            relatedEntityId: row.id,
          });
          if (result.jobId !== null || result.deduped) anySucceeded = true;
        }
        if (!anySucceeded) {
          console.error('[approvalSla] all reminder enqueue attempts failed — will retry next tick', { requestId: row.id });
          continue; // sla_reminder_sent_at stays NULL — retried next tick
        }
        await client.query(`UPDATE approval_requests SET sla_reminder_sent_at = NOW() WHERE id = $1`, [row.id]);
        reminded++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[approvalSla] sweepApprovalSla failed', err);
  } finally {
    client.release();
  }
  return { reminded, breached, routingFailures };
}
