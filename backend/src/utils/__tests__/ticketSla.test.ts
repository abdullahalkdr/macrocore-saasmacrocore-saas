import { beforeEach, describe, expect, it, vi } from 'vitest';

// Behavioral, mocked-pool tests — same shape helpdeskRecipients.test.ts and
// itsmAuthorization.test.ts already use in this suite (mock db/pool, exercise
// the REAL module under test, match queries by SQL substring). Unlike
// approvalSla.test.ts/email.test.ts's source-regression style (which exists
// specifically because those files' own tests never mock pool.connect() at
// all, so calling the guarded function for real would hit a live DB this
// sandbox has no network path for), sweepTicketSla() here IS actually
// invoked, end to end, against a fully mocked pool/resolver/enqueue layer —
// zero network I/O, real behavior.
//
// One honest boundary, not glossed over (per the Chat 3D audit, project doc
// claude/chat3d-helpdesk-sla-sweep-readonly-audit-2026-09-12.md): the final
// UPDATE's escalated_to/escalation_level CASE arithmetic runs inside real
// Postgres, not JS — these tests assert the CORRECT PARAMETERS ($3..$8) are
// computed and passed for each scenario (verified by inspecting the captured
// client.query call), while the SQL CASE formula itself was hand-traced
// against Postgres UPDATE semantics in the audit's rev. 7 §A and is exercised
// for real in the live-test plan (audit §G) that runs against production
// after this migration ships — a live DB is the only way to observe the
// actual post-UPDATE row.

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  resolveHelpdeskRecipients: vi.fn(),
  enqueueEmail: vi.fn(),
  // Post-Rev.7 fix (ChatGPT second-pass review, 2026-09-14): mocked as a
  // spy, not stubbed out — the factory below wires its default
  // implementation to the REAL ticketSlaEmailHtml so every existing
  // content-shape assertion (link format, etc.) keeps exercising real
  // template code. Only the new per-recipient-isolation test overrides it
  // (mockImplementationOnce) to simulate one recipient's buildEmail throwing.
  ticketSlaEmailHtml: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { connect: mocks.connect } }));

vi.mock('../helpdeskRecipients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helpdeskRecipients')>();
  return { ...actual, resolveHelpdeskRecipients: mocks.resolveHelpdeskRecipients };
});

vi.mock('../email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../email')>();
  mocks.ticketSlaEmailHtml.mockImplementation(actual.ticketSlaEmailHtml);
  return { ...actual, enqueueEmail: mocks.enqueueEmail, ticketSlaEmailHtml: mocks.ticketSlaEmailHtml };
});

vi.mock('../../config/env', () => ({
  env: { ENABLE_BACKGROUND_SWEEPS: true, FRONTEND_URL: 'https://app.macrocore.io' },
}));

import { sweepTicketSla, evaluateDimension, DEFAULT_SLA_MINUTES } from '../ticketSla';
import { env } from '../../config/env';
import type { ResolvedRecipient } from '../helpdeskRecipients';

const COMPANY_ID = 'company-1';

function recipient(over: Partial<ResolvedRecipient> & { userId: string }): ResolvedRecipient {
  return {
    email: `${over.userId}@macrocore.io`,
    recipientRole: 'assignee',
    preferredLanguage: 'ar',
    ...over,
  };
}

interface FakeRow {
  id: string;
  company_id: string;
  ticket_number: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
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

function row(over: Partial<FakeRow> & { id: string }): FakeRow {
  return {
    company_id: COMPANY_ID,
    ticket_number: 'GEN-2609-0001',
    priority: 'medium',
    created_by: 'user-requester',
    assigned_to: 'user-assignee',
    category: 'general',
    category_is_hr_sensitive: false,
    request_type_is_hr_sensitive: false,
    request_type_id: null,
    first_response_at: null,
    sla_response_due_at: null,
    sla_resolution_due_at: null,
    sla_response_breached: false,
    sla_resolution_breached: false,
    sla_response_escalated_at: null,
    sla_resolution_escalated_at: null,
    response_minutes: 240,
    resolution_minutes: 1440,
    escalate_after_minutes: 60,
    ...over,
  };
}

// Wires the mocked client so the candidate SELECT returns `rows`, every
// SAVEPOINT/RELEASE/ROLLBACK/BEGIN/COMMIT no-ops, and the final per-ticket
// UPDATE is captured (and, optionally, made to throw for specific ticket ids
// via `throwOnUpdateFor`) for assertions.
function installClient(
  rows: FakeRow[],
  opts: { throwOnUpdateFor?: Set<string>; throwOnRollbackToSavepoint?: boolean } = {}
) {
  mocks.clientQuery.mockReset();
  mocks.clientQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FOR UPDATE OF t SKIP LOCKED')) return { rows };
    if (sql.trim().startsWith('UPDATE support_tickets SET')) {
      const ticketId = params[0] as string;
      if (opts.throwOnUpdateFor?.has(ticketId)) throw new Error(`simulated UPDATE failure for ${ticketId}`);
      return { rows: [] };
    }
    // Post-Rev.7 fix (ChatGPT second-pass review, 2026-09-14): lets a test
    // simulate ROLLBACK TO SAVEPOINT itself failing, to exercise the
    // batch-abort-on-rollback-failure fix below.
    if (opts.throwOnRollbackToSavepoint && sql.trim().startsWith('ROLLBACK TO SAVEPOINT')) {
      throw new Error('simulated ROLLBACK TO SAVEPOINT failure');
    }
    return { rows: [] }; // BEGIN / COMMIT / ROLLBACK / SAVEPOINT / RELEASE / ROLLBACK TO
  });
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
}

function updateCallsFor(ticketId: string) {
  return mocks.clientQuery.mock.calls.filter((call: any[]) => {
    const sql = call[0] as string;
    const params = call[1] as unknown[];
    return sql.trim().startsWith('UPDATE support_tickets SET') && params[0] === ticketId;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  env.ENABLE_BACKGROUND_SWEEPS = true;
  mocks.resolveHelpdeskRecipients.mockResolvedValue({ event: 'sla_warning', recipients: [], diagnostic: { reason: 'no_eligible_recipient', detail: 'none configured for this test' } });
  mocks.enqueueEmail.mockResolvedValue({ jobId: 'job-1', deduped: false });
});

// ---------------------------------------------------------------------------
// evaluateDimension — pure function, exercised directly. Covers the
// escalationDue/escalatingNow split (audit rev. 6 point 1) and the
// escalate_after_minutes-null-means-never-escalates rule (rev. 5 §5,
// mirroring slaReport()'s existing INNER JOIN gate).
// ---------------------------------------------------------------------------
describe('evaluateDimension', () => {
  const HOUR = 60 * 60 * 1000;

  it('is not applicable at all when the dimension has no due date, or is gated off (response after first_response_at)', () => {
    const s = evaluateDimension(Date.now(), { applicable: false, dueAt: new Date().toISOString(), breached: false, escalatedAt: null, windowMinutes: 240, escalateAfterMinutes: 60 });
    expect(s).toEqual({ warningApplicable: false, breachDue: false, newlyBreached: false, escalationDue: false, escalatingNow: false });
  });

  it('warningApplicable fires at exactly 75% of the window (REMINDER_FRACTION), not before, not once breached', () => {
    const due = new Date('2026-09-12T12:00:00.000Z');
    const windowMinutes = 240; // 4h window -> warn 1h before due (75% elapsed)
    const justBefore = due.getTime() - 61 * 60 * 1000;
    const atThreshold = due.getTime() - 60 * 60 * 1000;
    const s1 = evaluateDimension(justBefore, { applicable: true, dueAt: due.toISOString(), breached: false, escalatedAt: null, windowMinutes, escalateAfterMinutes: null });
    const s2 = evaluateDimension(atThreshold, { applicable: true, dueAt: due.toISOString(), breached: false, escalatedAt: null, windowMinutes, escalateAfterMinutes: null });
    expect(s1.warningApplicable).toBe(false);
    expect(s2.warningApplicable).toBe(true);
  });

  it('newlyBreached is true exactly once (the transition tick); breachDue stays true on every later tick regardless — the free-retry mechanism', () => {
    const due = new Date('2026-09-12T12:00:00.000Z');
    const transitionTick = evaluateDimension(due.getTime(), { applicable: true, dueAt: due.toISOString(), breached: false, escalatedAt: null, windowMinutes: 240, escalateAfterMinutes: null });
    expect(transitionTick.newlyBreached).toBe(true);
    expect(transitionTick.breachDue).toBe(true);
    const laterTick = evaluateDimension(due.getTime() + HOUR, { applicable: true, dueAt: due.toISOString(), breached: true, escalatedAt: null, windowMinutes: 240, escalateAfterMinutes: null });
    expect(laterTick.newlyBreached).toBe(false);
    expect(laterTick.breachDue).toBe(true); // still attempted every tick — this is the point-9/point-1 retry fix
  });

  it('escalationDue is true every tick past threshold even after the first (escalatingNow) tick — the retry gap the audit fixed', () => {
    const due = new Date('2026-09-12T12:00:00.000Z');
    const escalateAt = due.getTime() + HOUR; // escalate_after_minutes = 60
    const firstTick = evaluateDimension(escalateAt, { applicable: true, dueAt: due.toISOString(), breached: true, escalatedAt: null, windowMinutes: 240, escalateAfterMinutes: 60 });
    expect(firstTick.escalationDue).toBe(true);
    expect(firstTick.escalatingNow).toBe(true); // timestamp not yet set -> this IS the write tick
    const laterTick = evaluateDimension(escalateAt + HOUR, { applicable: true, dueAt: due.toISOString(), breached: true, escalatedAt: new Date(escalateAt).toISOString(), windowMinutes: 240, escalateAfterMinutes: 60 });
    expect(laterTick.escalationDue).toBe(true); // still attempted -> resolver/enqueue retried even though...
    expect(laterTick.escalatingNow).toBe(false); // ...the DB state is not re-written (already recorded)
  });

  it('escalate_after_minutes === null means this dimension never escalates, no matter how overdue', () => {
    const due = new Date('2026-09-12T12:00:00.000Z');
    const s = evaluateDimension(due.getTime() + 1000 * HOUR, { applicable: true, dueAt: due.toISOString(), breached: true, escalatedAt: null, windowMinutes: 240, escalateAfterMinutes: null });
    expect(s.escalationDue).toBe(false);
    expect(s.escalatingNow).toBe(false);
  });
});

describe('DEFAULT_SLA_MINUTES', () => {
  it('covers all four priorities with a response/resolution pair, matching the values ticket create()/reopen already use', () => {
    expect(DEFAULT_SLA_MINUTES).toEqual({
      low: { response: 480, resolution: 4320 },
      medium: { response: 240, resolution: 1440 },
      high: { response: 60, resolution: 480 },
      urgent: { response: 30, resolution: 240 },
    });
  });
});

// ---------------------------------------------------------------------------
// sweepTicketSla() — end to end, fully mocked (no network).
// ---------------------------------------------------------------------------
describe('sweepTicketSla — guard', () => {
  it('checks env.ENABLE_BACKGROUND_SWEEPS and returns BEFORE any pool.connect() call', async () => {
    env.ENABLE_BACKGROUND_SWEEPS = false;
    const result = await sweepTicketSla();
    expect(result).toEqual({ processed: 0, failed: 0, warned: 0, breached: 0, escalated: 0 });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

describe('sweepTicketSla — candidate query shape', () => {
  it('uses FOR UPDATE OF t SKIP LOCKED and orders by sla_last_swept_at first (round-robin fairness) before urgency', async () => {
    installClient([]);
    await sweepTicketSla();
    const selectCall = mocks.clientQuery.mock.calls.find((call: any[]) => (call[0] as string).includes('FOR UPDATE OF t SKIP LOCKED'));
    expect(selectCall).toBeDefined();
    const sql: string = selectCall![0];
    // Post-Rev.7 fix (ChatGPT second-pass review, 2026-09-14): must name the
    // table ("OF t"), not bare FOR UPDATE — this query LEFT JOINs to
    // ticket_categories/service_request_types/sla_policies, and Postgres
    // rejects a bare FOR UPDATE against a query with outer joins ("FOR
    // UPDATE cannot be applied to the nullable side of an outer join").
    expect(sql).toContain('FOR UPDATE OF t SKIP LOCKED');
    expect(sql).toContain("COALESCE(t.sla_last_swept_at, '-infinity') ASC");
    expect(sql).toContain("t.status NOT IN ('resolved', 'closed')");
  });
});

describe('sweepTicketSla — dimension independence (first_response_at gates response only)', () => {
  it('an answered ticket (first_response_at set) still processes its still-open resolution dimension', async () => {
    const due = new Date(Date.now() - 60_000).toISOString(); // already overdue
    const r = row({ id: 'ticket-1', first_response_at: new Date().toISOString(), sla_resolution_due_at: due, escalate_after_minutes: null });
    installClient([r]);
    mocks.resolveHelpdeskRecipients.mockResolvedValue({ event: 'sla_breach', recipients: [recipient({ userId: 'user-assignee' })], diagnostic: null });

    await sweepTicketSla();

    const dedupKeys = mocks.enqueueEmail.mock.calls.map((call: any[]) => (call[0] as { dedupKey: string }).dedupKey);
    expect(dedupKeys.some((k: string) => k.includes(':resolution:'))).toBe(true);
    expect(dedupKeys.some((k: string) => k.includes(':response:'))).toBe(false);
  });
});

describe('sweepTicketSla — dedup key shape', () => {
  it('builds event:type:ticketId:cycleKey:recipientId, distinct per event/type/cycle/recipient', async () => {
    const responseDue = new Date(Date.now() - 60_000).toISOString();
    const resolutionDue = new Date(Date.now() - 120_000).toISOString();
    const r = row({ id: 'ticket-2', sla_response_due_at: responseDue, sla_resolution_due_at: resolutionDue, escalate_after_minutes: null });
    installClient([r]);
    mocks.resolveHelpdeskRecipients.mockResolvedValue({ event: 'sla_breach', recipients: [recipient({ userId: 'user-assignee' })], diagnostic: null });

    await sweepTicketSla();

    const dedupKeys = mocks.enqueueEmail.mock.calls.map((call: any[]) => (call[0] as { dedupKey: string }).dedupKey);
    expect(dedupKeys).toContain(`helpdesk_sla_breach:response:ticket-2:${new Date(responseDue).toISOString()}:user-assignee`);
    expect(dedupKeys).toContain(`helpdesk_sla_breach:resolution:ticket-2:${new Date(resolutionDue).toISOString()}:user-assignee`);
  });

  it('a reopen (new sla_resolution_due_at, unchanged sla_response_due_at) changes only the resolution cycle key', async () => {
    const responseDue = new Date(Date.now() - 60_000).toISOString();
    const beforeReopenResolutionDue = new Date(Date.now() - 60_000).toISOString();
    const afterReopenResolutionDue = new Date(Date.now() - 30_000).toISOString();
    mocks.resolveHelpdeskRecipients.mockResolvedValue({ event: 'sla_breach', recipients: [recipient({ userId: 'user-assignee' })], diagnostic: null });

    installClient([row({ id: 'ticket-3', sla_response_due_at: responseDue, sla_resolution_due_at: beforeReopenResolutionDue, escalate_after_minutes: null })]);
    await sweepTicketSla();
    const firstKeys = mocks.enqueueEmail.mock.calls.map((call: any[]) => (call[0] as { dedupKey: string }).dedupKey);

    // mock.calls accumulates across sweeps (installClient only replaces
    // clientQuery's implementation, it doesn't reset call history) — without
    // this clear, secondKeys would still contain the first sweep's calls and
    // .find() below would silently return the FIRST sweep's resolution key
    // for both variables, always passing regardless of whether the real
    // cycle-key logic is correct. Isolate the second sweep's own emails.
    mocks.enqueueEmail.mockClear();

    installClient([row({ id: 'ticket-3', sla_response_due_at: responseDue, sla_resolution_due_at: afterReopenResolutionDue, escalate_after_minutes: null })]);
    await sweepTicketSla();
    const secondKeys = mocks.enqueueEmail.mock.calls.map((call: any[]) => (call[0] as { dedupKey: string }).dedupKey);

    const responseKey = `helpdesk_sla_breach:response:ticket-3:${new Date(responseDue).toISOString()}:user-assignee`;
    expect(firstKeys).toContain(responseKey);
    expect(secondKeys).toContain(responseKey); // response cycle key unchanged across the reopen
    const firstResolutionKey = firstKeys.find((k: string) => k.includes(':resolution:'));
    const secondResolutionKey = secondKeys.find((k: string) => k.includes(':resolution:'));
    expect(firstResolutionKey).not.toBe(secondResolutionKey); // resolution cycle key changed
  });
});

describe('sweepTicketSla — HR context and recipient source', () => {
  it('passes the full HR triple (category, category_is_hr_sensitive, request_type_is_hr_sensitive) and the real requester through to the resolver', async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    const r = row({ id: 'ticket-hr', sla_response_due_at: due, category: 'grievance', category_is_hr_sensitive: true, request_type_is_hr_sensitive: true, created_by: 'user-real-requester', escalate_after_minutes: null });
    installClient([r]);
    await sweepTicketSla();

    expect(mocks.resolveHelpdeskRecipients).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: expect.objectContaining({
          category: 'grievance',
          category_is_hr_sensitive: true,
          request_type_is_hr_sensitive: true,
          created_by: 'user-real-requester',
        }),
      })
    );
  });

  it('every recipient comes from resolveHelpdeskRecipients() — no separate/blind recipient query exists in this module', async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    installClient([row({ id: 'ticket-4', sla_response_due_at: due, escalate_after_minutes: null })]);
    await sweepTicketSla();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled(); // default mock returns zero recipients
    expect(mocks.resolveHelpdeskRecipients).toHaveBeenCalled();
  });
});

describe('sweepTicketSla — link format', () => {
  it('every SLA email links to exactly /support?ticket=<id>, nothing else', async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    installClient([row({ id: 'ticket-5', sla_response_due_at: due, escalate_after_minutes: null })]);
    mocks.resolveHelpdeskRecipients.mockResolvedValue({ event: 'sla_breach', recipients: [recipient({ userId: 'user-assignee' })], diagnostic: null });
    await sweepTicketSla();
    const [{ html }] = mocks.enqueueEmail.mock.calls[0];
    expect(html).toContain('href="https://app.macrocore.io/support?ticket=ticket-5"');
  });
});

describe('sweepTicketSla — no recipient fails neither the ticket nor the batch', () => {
  it('zero eligible recipients still stamps sla_last_swept_at and reaches COMMIT', async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    installClient([row({ id: 'ticket-6', sla_response_due_at: due, escalate_after_minutes: null })]);
    const result = await sweepTicketSla();
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(updateCallsFor('ticket-6').length).toBe(1);
    expect(mocks.clientQuery.mock.calls.some((call: any[]) => call[0] === 'COMMIT')).toBe(true);
  });
});

describe('sweepTicketSla — resolver failure isolation (per ticket, per event)', () => {
  it("a resolver throw on one event doesn't block another event for the SAME ticket", async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    installClient([row({ id: 'ticket-7', sla_response_due_at: due, sla_resolution_due_at: due, escalate_after_minutes: null })]);
    mocks.resolveHelpdeskRecipients
      .mockRejectedValueOnce(new Error('simulated resolver failure for the first event evaluated (response breach)'))
      .mockResolvedValueOnce({ event: 'sla_breach', recipients: [recipient({ userId: 'user-assignee' })], diagnostic: null });

    const result = await sweepTicketSla();

    expect(mocks.resolveHelpdeskRecipients).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueEmail).toHaveBeenCalledTimes(1); // the second (resolution) call still sent its email
    expect(result.failed).toBe(0); // caught inside resolveAndNotify, never reaches the per-ticket SAVEPOINT catch
  });

  it('one escalation recipient returning jobId:null does not stop the rest and records the first successfully queued recipient', async () => {
    const due = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    installClient([row({ id: 'ticket-8', sla_response_due_at: due, sla_response_breached: true, escalate_after_minutes: 60 })]);
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'escalation',
      recipients: [recipient({ userId: 'user-a' }), recipient({ userId: 'user-b' })],
      diagnostic: null,
    });
    mocks.enqueueEmail.mockResolvedValueOnce({ jobId: null, deduped: false }).mockResolvedValueOnce({ jobId: 'job-2', deduped: false });

    await sweepTicketSla();

    expect(mocks.enqueueEmail).toHaveBeenCalledTimes(2);
    const [, params] = updateCallsFor('ticket-8')[0];
    expect(params[6]).toBe('user-b');
  });
});

describe('sweepTicketSla — SAVEPOINT rollback isolation across the batch', () => {
  it('one ticket whose final UPDATE throws rolls back only that ticket and lets the rest of the batch commit', async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    installClient(
      [row({ id: 'ticket-bad', sla_response_due_at: due, escalate_after_minutes: null }), row({ id: 'ticket-good', sla_response_due_at: due, escalate_after_minutes: null })],
      { throwOnUpdateFor: new Set(['ticket-bad']) }
    );

    const result = await sweepTicketSla();

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    const calls = mocks.clientQuery.mock.calls.map((call: any[]) => (call[0] as string).trim());
    expect(calls).toContain('SAVEPOINT ticket_sla_0');
    expect(calls).toContain('ROLLBACK TO SAVEPOINT ticket_sla_0');
    expect(calls).toContain('SAVEPOINT ticket_sla_1');
    expect(calls).toContain('RELEASE SAVEPOINT ticket_sla_1');
    expect(calls).not.toContain('ROLLBACK TO SAVEPOINT ticket_sla_1');
    expect(calls).toContain('COMMIT'); // the batch still commits — one bad ticket doesn't abort the rest
  });
});

describe('sweepTicketSla — SAVEPOINT-rollback FAILURE aborts the whole batch (fix, 2026-09-14)', () => {
  it('when ROLLBACK TO SAVEPOINT itself throws, the error is re-thrown to the outer catch: whole-batch ROLLBACK runs, COMMIT never happens, and no later ticket in the batch is even started', async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    installClient(
      [
        row({ id: 'ticket-bad', sla_response_due_at: due, escalate_after_minutes: null }),
        row({ id: 'ticket-good', sla_response_due_at: due, escalate_after_minutes: null }),
      ],
      { throwOnUpdateFor: new Set(['ticket-bad']), throwOnRollbackToSavepoint: true }
    );

    const result = await sweepTicketSla();

    // Previously (the bug) this would silently continue to ticket-good and
    // attempt COMMIT despite the transaction possibly being corrupted. Now
    // the rollback failure propagates out of the per-ticket catch, past the
    // for-loop, into sweepTicketSla()'s own outer try/catch.
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    const calls = mocks.clientQuery.mock.calls.map((call: any[]) => (call[0] as string).trim());
    expect(calls).toContain('SAVEPOINT ticket_sla_0');
    expect(calls).toContain('ROLLBACK TO SAVEPOINT ticket_sla_0');
    expect(calls).not.toContain('RELEASE SAVEPOINT ticket_sla_0'); // never reached — ROLLBACK TO SAVEPOINT itself threw
    expect(calls).not.toContain('SAVEPOINT ticket_sla_1'); // ticket-good never even started
    expect(calls).toContain('ROLLBACK'); // whole-batch rollback via the OUTER catch
    expect(calls).not.toContain('COMMIT'); // never reached
  });
});

describe('sweepTicketSla — per-recipient failure isolation inside resolveAndNotify (fix, 2026-09-14)', () => {
  it("one recipient's buildEmail throwing doesn't block the rest of that event's recipients (previously the whole loop aborted after the first failure)", async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    installClient([row({ id: 'ticket-9', sla_response_due_at: due, escalate_after_minutes: null })]);
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'sla_breach',
      recipients: [recipient({ userId: 'user-first' }), recipient({ userId: 'user-second' })],
      diagnostic: null,
    });
    // Only the FIRST call (first recipient's buildEmail) throws; the second
    // recipient falls through to the real implementation via the default
    // mockImplementation wired in the vi.mock('../email', ...) factory.
    mocks.ticketSlaEmailHtml.mockImplementationOnce(() => {
      throw new Error('simulated buildEmail failure for the first recipient only');
    });

    await sweepTicketSla();

    expect(mocks.enqueueEmail).toHaveBeenCalledTimes(1); // exactly one email actually sent
    const [{ to }] = mocks.enqueueEmail.mock.calls[0];
    expect(to).toBe('user-second@macrocore.io'); // confirms the SECOND recipient went through — the loop didn't just stop after the first
  });
});

describe('sweepTicketSla — escalation suppresses the redundant same-tick breach email (fix, 2026-09-14)', () => {
  // Abdullah/ChatGPT's decision (2026-09-14): when breachDue and
  // escalationDue are both true for the same dimension on the same tick
  // (e.g. the sweep ran late), sending both a breach and an escalation
  // email is redundant — send only escalation. The breach FLAG passed to
  // TICKET_UPDATE (newlyBreached) is unaffected; only the extra breach
  // EMAIL is suppressed. Mirrors the existing precedent where breachedNow
  // already suppresses a late warning (warningApplicable = !breachedNow...).
  it('response dimension: only the escalation email sends, and the response breach flag is still recorded', async () => {
    const due = new Date(Date.now() - 2 * 60 * 60_000).toISOString(); // 2h overdue
    installClient([row({ id: 'ticket-esc-resp', sla_response_due_at: due, sla_response_breached: false, escalate_after_minutes: 60 })]);
    mocks.resolveHelpdeskRecipients.mockResolvedValue({ event: 'escalation', recipients: [recipient({ userId: 'user-esc-r' })], diagnostic: null });

    await sweepTicketSla();

    expect(mocks.enqueueEmail).toHaveBeenCalledTimes(1); // not 2 — the breach email was suppressed
    const dedupKeys = mocks.enqueueEmail.mock.calls.map((call: any[]) => (call[0] as { dedupKey: string }).dedupKey);
    expect(dedupKeys.some((k: string) => k.startsWith('helpdesk_escalation:response:'))).toBe(true);
    expect(dedupKeys.some((k: string) => k.startsWith('helpdesk_sla_breach:response:'))).toBe(false);

    const [, params] = updateCallsFor('ticket-esc-resp')[0];
    expect(params[2]).toBe(true); // newlyBreached (response) — still recorded even though the breach EMAIL was suppressed
  });

  it('resolution dimension: same escalation-over-breach suppression applies', async () => {
    const due = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    installClient([row({ id: 'ticket-esc-reso', sla_resolution_due_at: due, sla_resolution_breached: false, escalate_after_minutes: 60 })]);
    mocks.resolveHelpdeskRecipients.mockResolvedValue({ event: 'escalation', recipients: [recipient({ userId: 'user-esc-o' })], diagnostic: null });

    await sweepTicketSla();

    expect(mocks.enqueueEmail).toHaveBeenCalledTimes(1);
    const dedupKeys = mocks.enqueueEmail.mock.calls.map((call: any[]) => (call[0] as { dedupKey: string }).dedupKey);
    expect(dedupKeys.some((k: string) => k.startsWith('helpdesk_escalation:resolution:'))).toBe(true);
    expect(dedupKeys.some((k: string) => k.startsWith('helpdesk_sla_breach:resolution:'))).toBe(false);

    const [, params] = updateCallsFor('ticket-esc-reso')[0];
    expect(params[3]).toBe(true); // newlyBreached (resolution) — still recorded
  });
});

describe('sweepTicketSla — escalation write parameters (§7/§A of the audit)', () => {
  // The CASE arithmetic itself runs in Postgres (see this file's header
  // comment on the live-DB boundary) — these assert the JS layer computes
  // and passes the correct $3..$8 parameters for each scenario.
  it('response-only escalating now: $5=true, $6=false, $7=recipient, $8=null', async () => {
    const due = new Date(Date.now() - 2 * 60 * 60_000).toISOString(); // breached long enough ago to be past escalate_after_minutes too
    installClient([row({ id: 'ticket-e1', sla_response_due_at: due, sla_response_breached: true, escalate_after_minutes: 60 })]);
    mocks.resolveHelpdeskRecipients.mockResolvedValue({ event: 'escalation', recipients: [recipient({ userId: 'user-esc' })], diagnostic: null });

    await sweepTicketSla();

    const [, params] = updateCallsFor('ticket-e1')[0];
    expect(params[2]).toBe(false); // newResponseBreach (already breached, not newly)
    expect(params[4]).toBe(true); // responseEscalatingNow
    expect(params[5]).toBe(false); // resolutionEscalatingNow
    expect(params[6]).toBe('user-esc'); // $7
    expect(params[7]).toBe(null); // $8
  });

  it('escalated-but-recipient-missing retries: escalatingNow false on a later tick, but the resolver/enqueue is still attempted', async () => {
    const due = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    installClient([
      row({ id: 'ticket-e2', sla_response_due_at: due, sla_response_breached: true, sla_response_escalated_at: new Date(Date.now() - 60_000).toISOString(), escalate_after_minutes: 60 }),
    ]);
    mocks.resolveHelpdeskRecipients.mockResolvedValue({ event: 'escalation', recipients: [recipient({ userId: 'user-late' })], diagnostic: null });

    await sweepTicketSla();

    expect(mocks.resolveHelpdeskRecipients).toHaveBeenCalled(); // retried despite the timestamp already being set
    const [, params] = updateCallsFor('ticket-e2')[0];
    expect(params[4]).toBe(false); // escalatingNow — already recorded, not re-written
    expect(params[6]).toBe('user-late'); // backfill candidate still passed through for the UPDATE's COALESCE to use
  });
});
