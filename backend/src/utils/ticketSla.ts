import { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { env } from '../config/env';
import { enqueueEmail, ticketSlaEmailHtml } from './email';
import { resolveHelpdeskRecipients, HelpdeskTicketEvent, ResolvedRecipient, TicketPriority } from './helpdeskRecipients';
import { ItsmTicketAccessContext } from './itsmApprovals';

// Chat 3D (Stage 5) — Helpdesk SLA background sweep. Mirrors approvalSla.ts's
// sweepApprovalSla() mechanism (guard-first, pool.connect(), one
// BEGIN...COMMIT, SELECT ... FOR UPDATE SKIP LOCKED) but goes further on
// failure isolation (a SAVEPOINT per ticket, not just one whole-batch
// try/catch) per the Chat 3D audit (rev. 4 §C onward — project doc
// claude/chat3d-helpdesk-sla-sweep-readonly-audit-2026-09-12.md).
//
// Domain logic reused, not duplicated: every recipient comes from
// resolveHelpdeskRecipients() (helpdeskRecipients.ts) — the exact same
// resolver Stage 2/3's lifecycle/reply notifications already use — so this
// sweep adds no new authorization rule and no second definition of "who can
// see this ticket" or "who is HR-authorized". Email content comes from
// ticketSlaEmailHtml() (email.ts), which carries no ticket subject/
// description/reply/attachment content by design — structurally impossible
// to leak HR-sensitive ticket content through an SLA email.
//
// DEFAULT_SLA_MINUTES lives here (not in supportTickets.controller.ts) so
// this utility never has to import a controller — supportTickets.controller.ts
// imports it FROM here instead, matching this codebase's existing dependency
// direction (controllers import utils, never the reverse).
export const DEFAULT_SLA_MINUTES: Record<string, { response: number; resolution: number }> = {
  low: { response: 480, resolution: 4320 },
  medium: { response: 240, resolution: 1440 },
  high: { response: 60, resolution: 480 },
  urgent: { response: 30, resolution: 240 },
};

const REMINDER_FRACTION = 0.75;

function ticketLink(ticketId: string): string {
  // Deliberately duplicated, not imported/exported — see the Chat 3D audit's
  // Decision 7: a two-token string is not worth a shared helper, and this
  // avoids any controller <-> utils import cycle. Must stay byte-for-byte
  // identical to supportTickets.controller.ts's own private ticketLink().
  return `${env.FRONTEND_URL}/support?ticket=${ticketId}`;
}

interface TicketSlaCandidateRow {
  id: string;
  company_id: string;
  ticket_number: string;
  priority: TicketPriority;
  created_by: string;
  assigned_to: string | null;
  category: string;
  category_is_hr_sensitive: boolean;
  request_type_is_hr_sensitive: boolean;
  request_type_id: string | null;
  first_response_at: string | null;
  sla_response_due_at: string | null;
  sla_resolution_due_at: string | null;
  sla_response_breached: boolean;
  sla_resolution_breached: boolean;
  sla_response_escalated_at: string | null;
  sla_resolution_escalated_at: string | null;
  response_minutes: number | null;
  resolution_minutes: number | null;
  escalate_after_minutes: number | null;
}

// Every SLA-eligible field the sweep needs to reason about, per dimension
// (response/resolution) — see the audit's escalationDue/escalatingNow split
// (rev. 6 point 1): escalationDue drives the free, dedup-protected retry of
// the escalation email every tick; escalatingNow is true only on the ONE
// tick the DB state (timestamp, escalation_level, legacy escalated_to/at)
// actually gets written. breachDue is the same split applied to breach:
// breachedNow (== breachDue) is attempted every tick regardless of whether
// the flag is already true, so a failed enqueueEmail() attempt is retried
// for free via the exact same mechanism warnings already use — closing the
// "flag persisted, email never sent, ticket falls out of eligibility
// forever" gap the audit's rev. 4 §9/rev. 6 point 1 fixed.
export interface DimensionState {
  warningApplicable: boolean;
  breachDue: boolean;
  newlyBreached: boolean;
  escalationDue: boolean;
  escalatingNow: boolean;
}

export function evaluateDimension(
  nowMs: number,
  input: {
    applicable: boolean; // response: first_response_at === null; resolution: always true (status already filtered)
    dueAt: string | null;
    breached: boolean;
    escalatedAt: string | null;
    windowMinutes: number; // the same minutes value used to compute dueAt — response/resolution minutes, with the DEFAULT_SLA_MINUTES fallback already applied
    escalateAfterMinutes: number | null;
  }
): DimensionState {
  if (!input.applicable || input.dueAt === null) {
    return { warningApplicable: false, breachDue: false, newlyBreached: false, escalationDue: false, escalatingNow: false };
  }
  const dueMs = new Date(input.dueAt).getTime();
  const newlyBreached = !input.breached && nowMs >= dueMs;
  const breachedNow = input.breached || newlyBreached;
  const warningAtMs = dueMs - input.windowMinutes * 60_000 * (1 - REMINDER_FRACTION);
  const warningApplicable = !breachedNow && nowMs >= warningAtMs && nowMs < dueMs;
  const escalationDue =
    breachedNow && input.escalateAfterMinutes !== null && nowMs >= dueMs + input.escalateAfterMinutes * 60_000;
  const escalatingNow = escalationDue && input.escalatedAt === null;
  return { warningApplicable, breachDue: breachedNow, newlyBreached, escalationDue, escalatingNow };
}

// Single point every SLA email is resolved and sent through — per-(ticket,
// event) failure isolation (audit rev. 6 point 8): a thrown error from the
// resolver is caught and logged, returning an empty recipient list —
// indistinguishable downstream from a genuine zero-eligible-recipient
// outcome, so one event's resolver failure never blocks another event,
// another dimension, or the rest of the batch. Returns the recipients that
// were ACTUALLY notified so the caller can take the first one for
// escalated_to (Decision 6 — first recipient in the resolver's own
// deterministic order) without recording someone whose email never went
// out.
//
// Post-Rev.7 fix (ChatGPT second-pass review, 2026-09-14): the resolver
// call and the per-recipient send loop are now in SEPARATE try/catch
// blocks. Previously both lived under one try/catch, so buildEmail()
// throwing for one recipient (it's synchronous HTML templating — not
// impossible to throw, e.g. a bad template interpolation) would abort the
// whole loop and silently skip every recipient after it for that event —
// violating the audit's own "failure isolation per ticket/event/recipient"
// requirement, which this closes at the recipient level too, not just the
// ticket/event level.
async function resolveAndNotify(params: {
  companyId: string;
  ticketId: string;
  event: HelpdeskTicketEvent;
  ticket: ItsmTicketAccessContext;
  priority: TicketPriority;
  currentAssigneeUserId?: string | null;
  buildEmail: (recipient: ResolvedRecipient) => { subject: string; html: string };
  dedupKeyFor: (recipient: ResolvedRecipient) => string;
}): Promise<ResolvedRecipient[]> {
  let candidates: ResolvedRecipient[];
  try {
    const resolution = await resolveHelpdeskRecipients({
      event: params.event,
      companyId: params.companyId,
      ticket: params.ticket,
      priority: params.priority,
      currentAssigneeUserId: params.currentAssigneeUserId,
    });
    candidates = resolution.recipients;
    if (candidates.length === 0) {
      console.error('[ticketSla] no eligible recipient', {
        ticketId: params.ticketId,
        event: params.event,
        reason: resolution.diagnostic?.reason,
      });
    }
  } catch (err) {
    console.error('[ticketSla] resolver failed', { ticketId: params.ticketId, event: params.event }, err);
    return [];
  }

  const notified: ResolvedRecipient[] = [];
  for (const recipient of candidates) {
    try {
      const { subject, html } = params.buildEmail(recipient);
      const enqueueResult = await enqueueEmail({
        to: recipient.email,
        subject,
        html,
        category: 'helpdesk',
        lang: recipient.preferredLanguage,
        dedupKey: params.dedupKeyFor(recipient),
        companyId: params.companyId,
        relatedEntityType: 'support_tickets',
        relatedEntityId: params.ticketId,
      });
      if (enqueueResult.jobId !== null) notified.push(recipient);
    } catch (err) {
      console.error('[ticketSla] failed to build/enqueue email for one recipient — other recipients for this event are still processed', { ticketId: params.ticketId, event: params.event, userId: recipient.userId }, err);
    }
  }
  return notified;
}

const CANDIDATE_QUERY = `
  SELECT
    t.id, t.company_id, t.ticket_number, t.priority,
    t.created_by, t.assigned_to, t.category, t.request_type_id,
    t.first_response_at,
    t.sla_response_due_at, t.sla_resolution_due_at,
    t.sla_response_breached, t.sla_resolution_breached,
    t.sla_response_escalated_at, t.sla_resolution_escalated_at,
    COALESCE(tc.is_hr_sensitive, false)  AS category_is_hr_sensitive,
    COALESCE(rt.is_hr_sensitive, false)  AS request_type_is_hr_sensitive,
    sp.response_minutes, sp.resolution_minutes, sp.escalate_after_minutes
  FROM support_tickets t
  LEFT JOIN ticket_categories      tc ON tc.id = t.category_id      AND tc.company_id = t.company_id
  LEFT JOIN service_request_types  rt ON rt.id = t.request_type_id  AND rt.company_id = t.company_id
  LEFT JOIN sla_policies           sp ON sp.company_id = t.company_id AND sp.priority = t.priority
  WHERE
    t.status NOT IN ('resolved', 'closed')
    AND (
         (t.first_response_at IS NULL AND t.sla_response_due_at   IS NOT NULL)
      OR (                                t.sla_resolution_due_at IS NOT NULL)
    )
  ORDER BY
    COALESCE(t.sla_last_swept_at, '-infinity') ASC,
    LEAST(COALESCE(t.sla_response_due_at, 'infinity'), COALESCE(t.sla_resolution_due_at, 'infinity')) ASC
  LIMIT $1
  -- Post-Rev.7 fix (ChatGPT second-pass review, 2026-09-14): "FOR UPDATE OF
  -- t", not bare "FOR UPDATE". This query LEFT JOINs to ticket_categories,
  -- service_request_types and sla_policies, and PostgreSQL raises "FOR
  -- UPDATE cannot be applied to the nullable side of an outer join" for a
  -- bare FOR UPDATE against a query with outer joins — a real runtime error
  -- against Postgres, invisible to this file's mocked-pool test suite.
  -- Naming the table restricts the row lock to support_tickets, which is the
  -- only table this query is claiming rows for.
  FOR UPDATE OF t SKIP LOCKED
`;

// Rev. 7's corrected escalated_to CASE (fixes the tie-break bug where
// `WHEN $6 THEN $8::uuid` won even when $8 was NULL, discarding a valid $7):
// each first branch now requires the recipient itself, not just the
// escalating-now flag, before it can win; a backfill (escalated_to still
// NULL, from an earlier tick that found no recipient) falls through to
// COALESCE($8, $7) once either dimension's resolver finds someone.
const TICKET_UPDATE = `
  UPDATE support_tickets SET
    sla_last_swept_at = NOW(),
    sla_response_breached = CASE WHEN $3 THEN true ELSE sla_response_breached END,
    sla_resolution_breached = CASE WHEN $4 THEN true ELSE sla_resolution_breached END,
    sla_response_escalated_at = CASE WHEN $5 THEN NOW() ELSE sla_response_escalated_at END,
    sla_resolution_escalated_at = CASE WHEN $6 THEN NOW() ELSE sla_resolution_escalated_at END,
    escalation_level =
        (CASE WHEN $5 THEN 1 WHEN sla_response_escalated_at IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN $6 THEN 1 WHEN sla_resolution_escalated_at IS NOT NULL THEN 1 ELSE 0 END),
    escalated_to = CASE
        WHEN $6 AND $8::uuid IS NOT NULL THEN $8::uuid
        WHEN $5 AND $7::uuid IS NOT NULL THEN $7::uuid
        WHEN escalated_to IS NULL THEN COALESCE($8::uuid, $7::uuid)
        ELSE escalated_to END,
    escalated_at = CASE WHEN $6 OR $5 THEN NOW() ELSE escalated_at END
  WHERE id = $1 AND company_id = $2
`;

async function processTicket(
  client: PoolClient,
  row: TicketSlaCandidateRow,
  nowMs: number
): Promise<{ warned: boolean; breached: boolean; escalated: boolean }> {
  const ticket: ItsmTicketAccessContext = {
    request_type_id: row.request_type_id,
    created_by: row.created_by,
    category: row.category,
    category_is_hr_sensitive: row.category_is_hr_sensitive,
    request_type_is_hr_sensitive: row.request_type_is_hr_sensitive,
    assigned_to: row.assigned_to,
  };
  const priority = row.priority;
  const fallback = DEFAULT_SLA_MINUTES[row.priority] ?? DEFAULT_SLA_MINUTES.medium;
  const responseMinutes = row.response_minutes ?? fallback.response;
  const resolutionMinutes = row.resolution_minutes ?? fallback.resolution;

  const responseCycleKey = row.sla_response_due_at ? new Date(row.sla_response_due_at).toISOString() : null;
  const resolutionCycleKey = row.sla_resolution_due_at ? new Date(row.sla_resolution_due_at).toISOString() : null;
  const link = ticketLink(row.id);

  const respState = evaluateDimension(nowMs, {
    applicable: row.first_response_at === null,
    dueAt: row.sla_response_due_at,
    breached: row.sla_response_breached,
    escalatedAt: row.sla_response_escalated_at,
    windowMinutes: responseMinutes,
    escalateAfterMinutes: row.escalate_after_minutes,
  });
  const resoState = evaluateDimension(nowMs, {
    applicable: true, // status NOT IN ('resolved','closed') already enforced by the candidate query
    dueAt: row.sla_resolution_due_at,
    breached: row.sla_resolution_breached,
    escalatedAt: row.sla_resolution_escalated_at,
    windowMinutes: resolutionMinutes,
    escalateAfterMinutes: row.escalate_after_minutes,
  });

  let warned = false;
  let responseFirstRecipient: string | null = null;
  let resolutionFirstRecipient: string | null = null;

  // --- response dimension ---
  if (respState.warningApplicable) {
    await resolveAndNotify({
      companyId: row.company_id,
      ticketId: row.id,
      event: 'sla_warning',
      ticket,
      priority,
      currentAssigneeUserId: row.assigned_to,
      buildEmail: (r) => ticketSlaEmailHtml({ lang: r.preferredLanguage, ticketNumber: row.ticket_number, severity: 'warning', slaType: 'response', link }),
      dedupKeyFor: (r) => `helpdesk_sla_warning:response:${row.id}:${responseCycleKey}:${r.userId}`,
    });
    warned = true;
  }
  // Post-Rev.7 fix (ChatGPT second-pass review, 2026-09-14): when a sweep
  // runs late enough that breachDue and escalationDue are BOTH true for the
  // same dimension on the same tick, only send the escalation email —
  // sending both is redundant (the escalation email already conveys "this
  // is breached AND past the escalation window"). Mirrors the existing
  // warningApplicable precedent, which is itself defined as `!breachedNow`
  // so breach already suppresses a late warning. The breach FLAG is still
  // recorded exactly as before (respState.newlyBreached, passed to
  // TICKET_UPDATE below) — only the redundant breach EMAIL is suppressed.
  if (respState.breachDue && !respState.escalationDue) {
    await resolveAndNotify({
      companyId: row.company_id,
      ticketId: row.id,
      event: 'sla_breach',
      ticket,
      priority,
      currentAssigneeUserId: row.assigned_to,
      buildEmail: (r) => ticketSlaEmailHtml({ lang: r.preferredLanguage, ticketNumber: row.ticket_number, severity: 'breach', slaType: 'response', link }),
      dedupKeyFor: (r) => `helpdesk_sla_breach:response:${row.id}:${responseCycleKey}:${r.userId}`,
    });
  }
  if (respState.escalationDue) {
    const recipients = await resolveAndNotify({
      companyId: row.company_id,
      ticketId: row.id,
      event: 'escalation',
      ticket,
      priority,
      buildEmail: (r) => ticketSlaEmailHtml({ lang: r.preferredLanguage, ticketNumber: row.ticket_number, severity: 'escalated', slaType: 'response', link }),
      dedupKeyFor: (r) => `helpdesk_escalation:response:${row.id}:${responseCycleKey}:${r.userId}`,
    });
    responseFirstRecipient = recipients[0]?.userId ?? null;
  }

  // --- resolution dimension ---
  if (resoState.warningApplicable) {
    await resolveAndNotify({
      companyId: row.company_id,
      ticketId: row.id,
      event: 'sla_warning',
      ticket,
      priority,
      currentAssigneeUserId: row.assigned_to,
      buildEmail: (r) => ticketSlaEmailHtml({ lang: r.preferredLanguage, ticketNumber: row.ticket_number, severity: 'warning', slaType: 'resolution', link }),
      dedupKeyFor: (r) => `helpdesk_sla_warning:resolution:${row.id}:${resolutionCycleKey}:${r.userId}`,
    });
    warned = true;
  }
  // Same escalation-over-breach priority as the response dimension above.
  if (resoState.breachDue && !resoState.escalationDue) {
    await resolveAndNotify({
      companyId: row.company_id,
      ticketId: row.id,
      event: 'sla_breach',
      ticket,
      priority,
      currentAssigneeUserId: row.assigned_to,
      buildEmail: (r) => ticketSlaEmailHtml({ lang: r.preferredLanguage, ticketNumber: row.ticket_number, severity: 'breach', slaType: 'resolution', link }),
      dedupKeyFor: (r) => `helpdesk_sla_breach:resolution:${row.id}:${resolutionCycleKey}:${r.userId}`,
    });
  }
  if (resoState.escalationDue) {
    const recipients = await resolveAndNotify({
      companyId: row.company_id,
      ticketId: row.id,
      event: 'escalation',
      ticket,
      priority,
      buildEmail: (r) => ticketSlaEmailHtml({ lang: r.preferredLanguage, ticketNumber: row.ticket_number, severity: 'escalated', slaType: 'resolution', link }),
      dedupKeyFor: (r) => `helpdesk_escalation:resolution:${row.id}:${resolutionCycleKey}:${r.userId}`,
    });
    resolutionFirstRecipient = recipients[0]?.userId ?? null;
  }

  // Always runs — stamps sla_last_swept_at for round-robin fairness (audit
  // rev. 6 point 7) even when neither dimension had anything to write.
  await client.query(TICKET_UPDATE, [
    row.id,
    row.company_id,
    respState.newlyBreached,
    resoState.newlyBreached,
    respState.escalatingNow,
    resoState.escalatingNow,
    responseFirstRecipient,
    resolutionFirstRecipient,
  ]);

  return { warned, breached: respState.newlyBreached || resoState.newlyBreached, escalated: respState.escalatingNow || resoState.escalatingNow };
}

export async function sweepTicketSla(
  limit = 50
): Promise<{ processed: number; failed: number; warned: number; breached: number; escalated: number }> {
  // Guard checked FIRST, before any pool access — same convention as
  // sweepApprovalSla()/sweepEmailQueue(), same reason (SLA timezone incident,
  // 2026-09-09 — see claude/sla-timezone-incident-2026-09-09.md, project doc).
  if (!env.ENABLE_BACKGROUND_SWEEPS) {
    return { processed: 0, failed: 0, warned: 0, breached: 0, escalated: 0 };
  }
  const client = await pool.connect();
  let processed = 0;
  let failed = 0;
  let warned = 0;
  let breached = 0;
  let escalated = 0;
  try {
    await client.query('BEGIN');
    const candidates = await client.query<TicketSlaCandidateRow>(CANDIDATE_QUERY, [limit]);
    const nowMs = Date.now();

    for (let i = 0; i < candidates.rows.length; i++) {
      const row = candidates.rows[i];
      const savepoint = `ticket_sla_${i}`;
      try {
        await client.query(`SAVEPOINT ${savepoint}`);
        const result = await processTicket(client, row, nowMs);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        processed++;
        if (result.warned) warned++;
        if (result.breached) breached++;
        if (result.escalated) escalated++;
      } catch (err) {
        failed++;
        console.error('[ticketSla] failed to process ticket — rolling back this ticket only, batch continues', { ticketId: row.id }, err);
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (rollbackErr) {
          // Post-Rev.7 fix (ChatGPT second-pass review, 2026-09-14): a failed
          // savepoint rollback means this client's transaction may now be in
          // an aborted/corrupted state — every subsequent query on it
          // (including the COMMIT this loop is working toward) is unsafe.
          // Previously this branch only logged and let the loop continue to
          // the next ticket; now it re-throws so the error escapes this
          // per-ticket try/catch entirely and is caught by the OUTER
          // try/catch below, which issues a full ROLLBACK for the whole
          // batch instead of attempting to COMMIT a possibly-corrupted
          // transaction.
          console.error('[ticketSla] failed to roll back savepoint — aborting whole batch', { ticketId: row.id }, rollbackErr);
          throw rollbackErr;
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ticketSla] sweepTicketSla failed', err);
  } finally {
    client.release();
  }
  return { processed, failed, warned, breached, escalated };
}
