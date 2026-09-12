import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// ============================================================================
// Stage 3 (Helpdesk/ITSM email wiring) — controller-level behavioral tests.
//
// Every other controller test file in this codebase (supportTickets.
// accessControl.test.ts, approvals.controller.test.ts, ...) uses source-text
// regression against the shipped file, because there has historically been no
// live-DB/Express path in this sandbox. That convention is not enough here:
// the user's Phase C review specifically required proving DYNAMIC runtime
// behavior — the exact dedup key strings built from live row data, that a
// rejected recipient-resolution/enqueue call never fails the primary ticket
// action, and that an HR-sensitive ticket's queued email genuinely omits the
// raw subject text (not just that the source calls the right function). None
// of that is checkable from static text.
//
// So this file follows the OTHER existing convention already in this
// codebase — utils/__tests__/helpdeskRecipients.test.ts and
// itsmAuthorization.test.ts — real vi.mock()'d pool with a SQL-substring
// responder, real business logic run end to end. asyncHandler is mocked to
// identity so create()/reply()/updateStatus() are directly awaitable (see
// utils/asyncHandler.ts — the real wrapper never returns its inner promise,
// so it can't be awaited directly from a test as shipped). db/pool, audit,
// sequences, planFeatures and permissions are fully mocked (none of their
// real behavior is what Stage 3 changed). itsmApprovals, helpdeskRecipients
// and email are PARTIALLY mocked via importOriginal — canAccessTicket(),
// isHrSensitiveTicket(), and the real ticketLifecycleEmailHtml()/
// ticketReplyEmailHtml() templates stay real (so the HR-redaction test
// exercises the actual template, not a stand-in), while getBlockingApproval/
// createItsmApprovalChain/getItsmApprovalSummary (out of Stage 3's scope),
// resolveHelpdeskRecipients (Stage 2, already covered by its own test file —
// fully mocked here so each test controls exactly who Stage 3 wiring thinks
// is eligible) and enqueueEmail (utils/email.ts's own delivery mechanics,
// already covered elsewhere) are stubbed.
// ============================================================================

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  logAudit: vi.fn(),
  generateTicketNumber: vi.fn(),
  planLevelOf: vi.fn(),
  hasPermission: vi.fn(),
  usersWithPermission: vi.fn(),
  getBlockingApproval: vi.fn(),
  createItsmApprovalChain: vi.fn(),
  getItsmApprovalSummary: vi.fn(),
  resolveHelpdeskRecipients: vi.fn(),
  enqueueEmail: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: mocks.query } }));
vi.mock('../../utils/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('../../utils/audit', () => ({ logAudit: mocks.logAudit }));
vi.mock('../../utils/sequences', () => ({ generateTicketNumber: mocks.generateTicketNumber }));
vi.mock('../../config/planFeatures', () => ({ planLevelOf: mocks.planLevelOf }));
vi.mock('../../utils/permissions', () => ({
  hasPermission: mocks.hasPermission,
  usersWithPermission: mocks.usersWithPermission,
}));
vi.mock('../../utils/itsmApprovals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/itsmApprovals')>();
  return {
    ...actual,
    getBlockingApproval: mocks.getBlockingApproval,
    createItsmApprovalChain: mocks.createItsmApprovalChain,
    getItsmApprovalSummary: mocks.getItsmApprovalSummary,
  };
});
vi.mock('../../utils/helpdeskRecipients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/helpdeskRecipients')>();
  return { ...actual, resolveHelpdeskRecipients: mocks.resolveHelpdeskRecipients };
});
vi.mock('../../utils/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/email')>();
  return { ...actual, enqueueEmail: mocks.enqueueEmail };
});

// config/env is intentionally NOT mocked — vitest.config.ts already supplies
// DATABASE_URL/JWT_SECRET for every test file, and FRONTEND_URL falls back
// to its real default ('http://localhost:3000'), which is exactly what
// ticketLink() will use — asserted against directly via the real `env`
// import below rather than a hardcoded duplicate string.
import { env } from '../../config/env';
import { create, reply, updateStatus } from '../supportTickets.controller';

const COMPANY_ID = 'company-1';

// asyncHandler is mocked to identity above, so at RUNTIME create()/reply()/
// updateStatus() only ever call their inner (req, res) function and never
// touch `next` — but they are still statically typed as Express's
// RequestHandler (asyncHandler's real, unmocked return type), which requires
// a third NextFunction argument. This satisfies the type-checker only; it is
// never invoked.
const NOOP_NEXT = (() => {}) as any;

function makeRes(): Response & { statusCode?: number; body?: any } {
  const res: any = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
}

function makeReq(over: { auth: any; body?: any; params?: any; query?: any }): Request {
  return {
    body: {},
    params: {},
    query: {},
    ...over,
  } as unknown as Request;
}

function ticketLink(ticketId: string): string {
  return `${env.FRONTEND_URL}/support?ticket=${ticketId}`;
}

function baseTicketRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ticket-1',
    ticket_number: 'GEN-2609-0001',
    subject: 'Secret salary issue',
    description: 'details',
    status: 'open',
    priority: 'medium',
    category: 'general',
    category_id: null,
    request_type_id: 'rt-1',
    dynamic_data: {},
    attachments: [],
    assigned_to: null,
    created_by: 'requester-1',
    category_is_hr_sensitive: false,
    request_type_is_hr_sensitive: false,
    first_response_at: null,
    resolved_at: null,
    sla_response_due_at: '2026-09-13T00:00:00.000Z',
    sla_resolution_due_at: '2026-09-13T00:00:00.000Z',
    sla_response_breached: false,
    sla_resolution_breached: false,
    escalation_level: 0,
    escalated_to: null,
    escalated_at: null,
    created_at: '2026-09-12T09:00:00.000Z',
    updated_at: '2026-09-12T10:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(true);
  mocks.planLevelOf.mockReturnValue(0);
  mocks.getBlockingApproval.mockResolvedValue(null);
  mocks.logAudit.mockResolvedValue(undefined);
  mocks.generateTicketNumber.mockResolvedValue('GEN-2609-0001');
  mocks.enqueueEmail.mockResolvedValue({ jobId: 'job-1', deduped: false });
  mocks.resolveHelpdeskRecipients.mockResolvedValue({ event: 'created', recipients: [], diagnostic: null });
});

// ============================================================================
// create()
// ============================================================================
describe('create() — Stage 3 lifecycle email wiring', () => {
  const AUTH = { userId: 'requester-1', companyId: COMPANY_ID, role: 'employee' };

  function mockCreatePool(world: {
    categoryId?: string | null;
    categoryIsHrSensitive?: boolean;
    requestTypeId?: string | null;
    requestTypeIsHrSensitive?: boolean;
    requesterEmployeeId?: string | null;
    insertedTicket: Record<string, unknown>;
  }) {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM ticket_categories WHERE id = $1 AND company_id = $2')) {
        return world.categoryId ? { rows: [{ id: world.categoryId, is_hr_sensitive: !!world.categoryIsHrSensitive }] } : { rows: [] };
      }
      if (sql.includes('FROM service_request_types WHERE id = $1 AND company_id = $2')) {
        return world.requestTypeId ? { rows: [{ id: world.requestTypeId, is_hr_sensitive: !!world.requestTypeIsHrSensitive }] } : { rows: [] };
      }
      if (sql.includes('FROM service_custom_fields WHERE company_id = $1 AND request_type_id = $2')) {
        return { rows: [] };
      }
      if (sql.includes('FROM sla_policies WHERE company_id = $1 AND priority = $2')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT employee_id FROM users WHERE id = $1')) {
        return { rows: [{ employee_id: world.requesterEmployeeId ?? null }] };
      }
      if (sql.includes('FROM employees e JOIN departments d')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO support_tickets')) {
        return { rows: [world.insertedTicket] };
      }
      if (sql.includes('SELECT plan FROM companies WHERE id = $1')) {
        return { rows: [{ plan: 'bronze' }] };
      }
      throw new Error(`Unexpected query in create() test: ${sql}`);
    });
  }

  it('an HR-sensitive created ticket (via request_type_id, legacy category still "general") never leaks the raw subject into the queued email', async () => {
    mockCreatePool({
      requestTypeId: 'rt-1',
      requestTypeIsHrSensitive: true,
      insertedTicket: baseTicketRow({ request_type_id: 'rt-1' }),
    });
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'created',
      recipients: [{ userId: 'requester-1', email: 'req@macrocore.io', recipientRole: 'requester', preferredLanguage: 'en' }],
      diagnostic: null,
    });

    const req = makeReq({
      auth: AUTH,
      body: { subject: 'Secret salary issue', description: 'details', category: 'general', request_type_id: 'rt-1' },
    });
    const res = makeRes();
    await create(req, res, NOOP_NEXT);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body.success).toBe(true);

    expect(mocks.resolveHelpdeskRecipients).toHaveBeenCalledTimes(1);
    const resolverArgs = mocks.resolveHelpdeskRecipients.mock.calls[0][0];
    // Retained from the catCheck/rtCheck validation queries, NOT read off the
    // RETURNING row (which has no is_hr_sensitive column at all) — this is
    // the exact bug the user's Phase C review caught in the first plan.
    expect(resolverArgs.ticket.request_type_is_hr_sensitive).toBe(true);
    expect(resolverArgs.ticket.category_is_hr_sensitive).toBe(false);

    expect(mocks.enqueueEmail).toHaveBeenCalledTimes(1);
    const enqueueArgs = mocks.enqueueEmail.mock.calls[0][0];
    expect(enqueueArgs.subject).not.toContain('Secret salary issue');
    expect(enqueueArgs.html).not.toContain('Secret salary issue');
    expect(enqueueArgs.category).toBe('helpdesk');
    expect(enqueueArgs.dedupKey).toBe('helpdesk_created:ticket-1');
    expect(enqueueArgs.relatedEntityType).toBe('support_tickets');
    expect(enqueueArgs.relatedEntityId).toBe('ticket-1');
    expect(enqueueArgs.to).toBe('req@macrocore.io');
  });

  it('a non-HR created ticket includes the real subject in the queued email (sanity check the redaction test above is meaningful)', async () => {
    mockCreatePool({ insertedTicket: baseTicketRow() });
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'created',
      recipients: [{ userId: 'requester-1', email: 'req@macrocore.io', recipientRole: 'requester', preferredLanguage: 'en' }],
      diagnostic: null,
    });
    const req = makeReq({ auth: AUTH, body: { subject: 'Secret salary issue', description: 'details' } });
    const res = makeRes();
    await create(req, res, NOOP_NEXT);
    const enqueueArgs = mocks.enqueueEmail.mock.calls[0][0];
    expect(enqueueArgs.html).toContain('Secret salary issue');
  });

  it('a recipient-resolution failure never fails ticket creation', async () => {
    mockCreatePool({ insertedTicket: baseTicketRow() });
    mocks.resolveHelpdeskRecipients.mockRejectedValue(new Error('resolver boom'));

    const req = makeReq({ auth: AUTH, body: { subject: 'x', description: 'y' } });
    const res = makeRes();
    await create(req, res, NOOP_NEXT);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body.success).toBe(true);
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });

  it('an enqueue failure never fails ticket creation', async () => {
    mockCreatePool({ insertedTicket: baseTicketRow() });
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'created',
      recipients: [{ userId: 'requester-1', email: 'req@macrocore.io', recipientRole: 'requester', preferredLanguage: 'ar' }],
      diagnostic: null,
    });
    mocks.enqueueEmail.mockRejectedValue(new Error('enqueue boom'));

    const req = makeReq({ auth: AUTH, body: { subject: 'x', description: 'y' } });
    const res = makeRes();
    await create(req, res, NOOP_NEXT);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body.success).toBe(true);
  });

  it('the ticket link is exactly /support?ticket=<ticketId>', async () => {
    mockCreatePool({ insertedTicket: baseTicketRow() });
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'created',
      recipients: [{ userId: 'requester-1', email: 'req@macrocore.io', recipientRole: 'requester', preferredLanguage: 'en' }],
      diagnostic: null,
    });
    const req = makeReq({ auth: AUTH, body: { subject: 'x', description: 'y' } });
    const res = makeRes();
    await create(req, res, NOOP_NEXT);
    expect(mocks.enqueueEmail.mock.calls[0][0].html).toContain(ticketLink('ticket-1'));
  });
});

// ============================================================================
// reply()
// ============================================================================
describe('reply() — Stage 3 reply email wiring', () => {
  const TICKET_ID = 'ticket-1';

  function mockReplyPool(world: { ticketRow: Record<string, unknown>; insertedReply: Record<string, unknown> }) {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('t.first_response_at, t.sla_response_due_at')) {
        return { rows: [world.ticketRow] };
      }
      if (sql.includes('INSERT INTO ticket_replies')) {
        return { rows: [world.insertedReply] };
      }
      if (sql.includes('SET first_response_at = NOW()')) {
        return { rows: [] };
      }
      if (sql.includes('SET updated_at = NOW() WHERE id = $1')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query in reply() test: ${sql}`);
    });
  }

  it('an internal note by a non-creator admin sends zero email', async () => {
    mockReplyPool({
      ticketRow: baseTicketRow({ id: TICKET_ID, created_by: 'requester-1', assigned_to: null }),
      insertedReply: { id: 'reply-1', user_id: 'admin-1', message: 'note', is_admin_reply: true, is_internal_note: true, attachments: [], created_at: 'now' },
    });
    const req = makeReq({
      auth: { userId: 'admin-1', companyId: COMPANY_ID, role: 'admin' },
      params: { id: TICKET_ID },
      body: { message: 'note', is_internal_note: true },
    });
    const res = makeRes();
    await reply(req, res, NOOP_NEXT);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mocks.resolveHelpdeskRecipients).not.toHaveBeenCalled();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });

  it('an internal note by an admin who created the ticket themselves also sends zero email (checked before creator status, not after)', async () => {
    mockReplyPool({
      ticketRow: baseTicketRow({ id: TICKET_ID, created_by: 'admin-1' }),
      insertedReply: { id: 'reply-2', user_id: 'admin-1', message: 'note', is_admin_reply: true, is_internal_note: true, attachments: [], created_at: 'now' },
    });
    const req = makeReq({
      auth: { userId: 'admin-1', companyId: COMPANY_ID, role: 'admin' },
      params: { id: TICKET_ID },
      body: { message: 'note', is_internal_note: true },
    });
    const res = makeRes();
    await reply(req, res, NOOP_NEXT);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mocks.resolveHelpdeskRecipients).not.toHaveBeenCalled();
  });

  it('a non-creator Viewer replying to someone else\'s ticket sends zero email (the Viewer access-breadth gap stays untouched by Stage 3)', async () => {
    mockReplyPool({
      ticketRow: baseTicketRow({ id: TICKET_ID, created_by: 'requester-1', assigned_to: null }),
      insertedReply: { id: 'reply-3', user_id: 'viewer-1', message: 'hi', is_admin_reply: false, is_internal_note: false, attachments: [], created_at: 'now' },
    });
    const req = makeReq({
      auth: { userId: 'viewer-1', companyId: COMPANY_ID, role: 'viewer' },
      params: { id: TICKET_ID },
      body: { message: 'hi' },
    });
    const res = makeRes();
    await reply(req, res, NOOP_NEXT);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mocks.resolveHelpdeskRecipients).not.toHaveBeenCalled();
  });

  it('an assigned employee\'s staff reply fires staff_reply with the ticket\'s real priority and the exact dedup key', async () => {
    mockReplyPool({
      ticketRow: baseTicketRow({
        id: TICKET_ID,
        created_by: 'requester-1',
        assigned_to: 'agent-1',
        priority: 'high',
        subject: 'Printer broken',
        ticket_number: 'IT-2609-0002',
      }),
      insertedReply: { id: 'reply-4', user_id: 'agent-1', message: 'looking into it', is_admin_reply: true, is_internal_note: false, attachments: [], created_at: 'now' },
    });
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'staff_reply',
      recipients: [{ userId: 'requester-1', email: 'req@macrocore.io', recipientRole: 'requester', preferredLanguage: 'ar' }],
      diagnostic: null,
    });
    const req = makeReq({
      auth: { userId: 'agent-1', companyId: COMPANY_ID, role: 'employee' },
      params: { id: TICKET_ID },
      body: { message: 'looking into it' },
    });
    const res = makeRes();
    await reply(req, res, NOOP_NEXT);

    expect(res.status).toHaveBeenCalledWith(201);
    const resolverArgs = mocks.resolveHelpdeskRecipients.mock.calls[0][0];
    expect(resolverArgs.event).toBe('staff_reply');
    // Real ticket priority, not undefined — a missing priority would silently
    // fall back to the resolver's default role instead of the SLA policy for
    // this ticket's actual priority (Phase D, point 1).
    expect(resolverArgs.priority).toBe('high');
    expect(resolverArgs.currentAssigneeUserId).toBe('agent-1');
    expect(mocks.enqueueEmail).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueEmail.mock.calls[0][0].dedupKey).toBe(`helpdesk_staff_reply:${TICKET_ID}:reply-4:requester-1`);
  });

  it("the ticket creator's own public reply fires requester_reply, never staff_reply", async () => {
    mockReplyPool({
      ticketRow: baseTicketRow({ id: TICKET_ID, created_by: 'requester-1', assigned_to: 'agent-1' }),
      insertedReply: { id: 'reply-5', user_id: 'requester-1', message: 'any update?', is_admin_reply: false, is_internal_note: false, attachments: [], created_at: 'now' },
    });
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'requester_reply',
      recipients: [{ userId: 'agent-1', email: 'agent@macrocore.io', recipientRole: 'assignee', preferredLanguage: 'ar' }],
      diagnostic: null,
    });
    const req = makeReq({
      auth: { userId: 'requester-1', companyId: COMPANY_ID, role: 'employee' },
      params: { id: TICKET_ID },
      body: { message: 'any update?' },
    });
    const res = makeRes();
    await reply(req, res, NOOP_NEXT);

    expect(mocks.resolveHelpdeskRecipients.mock.calls[0][0].event).toBe('requester_reply');
    expect(mocks.enqueueEmail.mock.calls[0][0].dedupKey).toBe(`helpdesk_requester_reply:${TICKET_ID}:reply-5:agent-1`);
  });

  it('a recipient-resolution failure never fails reply()', async () => {
    mockReplyPool({
      ticketRow: baseTicketRow({ id: TICKET_ID, created_by: 'requester-1', assigned_to: 'agent-1' }),
      insertedReply: { id: 'reply-6', user_id: 'agent-1', message: 'x', is_admin_reply: true, is_internal_note: false, attachments: [], created_at: 'now' },
    });
    mocks.resolveHelpdeskRecipients.mockRejectedValue(new Error('boom'));
    const req = makeReq({ auth: { userId: 'agent-1', companyId: COMPANY_ID, role: 'employee' }, params: { id: TICKET_ID }, body: { message: 'x' } });
    const res = makeRes();
    await reply(req, res, NOOP_NEXT);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('an enqueue failure never fails reply()', async () => {
    mockReplyPool({
      ticketRow: baseTicketRow({ id: TICKET_ID, created_by: 'requester-1', assigned_to: 'agent-1' }),
      insertedReply: { id: 'reply-7', user_id: 'agent-1', message: 'x', is_admin_reply: true, is_internal_note: false, attachments: [], created_at: 'now' },
    });
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'staff_reply',
      recipients: [{ userId: 'requester-1', email: 'req@macrocore.io', recipientRole: 'requester', preferredLanguage: 'ar' }],
      diagnostic: null,
    });
    mocks.enqueueEmail.mockRejectedValue(new Error('boom'));
    const req = makeReq({ auth: { userId: 'agent-1', companyId: COMPANY_ID, role: 'employee' }, params: { id: TICKET_ID }, body: { message: 'x' } });
    const res = makeRes();
    await reply(req, res, NOOP_NEXT);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

// ============================================================================
// updateStatus()
// ============================================================================
describe('updateStatus() — Stage 3 assignment/status email wiring', () => {
  const TICKET_ID = 'ticket-1';

  function mockUpdateStatusPool(world: {
    existingRow: Record<string, unknown>;
    categoryId?: string | null;
    nextCategoryIsHrSensitive?: boolean;
    assignedToUserExists?: boolean;
    updatedRow: Record<string, unknown>;
  }) {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('t.resolved_at, t.sla_resolution_due_at')) {
        return { rows: [world.existingRow] };
      }
      if (sql.includes('SELECT id FROM users WHERE id = $1 AND company_id = $2')) {
        return world.assignedToUserExists === false ? { rows: [] } : { rows: [{ id: 'ignored' }] };
      }
      if (sql.includes('FROM ticket_categories WHERE id = $1 AND company_id = $2')) {
        return world.categoryId ? { rows: [{ id: world.categoryId, is_hr_sensitive: !!world.nextCategoryIsHrSensitive }] } : { rows: [] };
      }
      if (sql.includes('SET status = COALESCE($1, status)')) {
        return { rows: [world.updatedRow] };
      }
      throw new Error(`Unexpected query in updateStatus() test: ${sql}`);
    });
  }

  it('an eligible plain-employee assignment on a non-HR ticket fires assignment_changed with the post-update context and canonical dedup key', async () => {
    const existingRow = baseTicketRow({ id: TICKET_ID, assigned_to: null, status: 'open', priority: 'medium' });
    const updatedRow = baseTicketRow({ id: TICKET_ID, assigned_to: 'employee-2', status: 'open', priority: 'medium', updated_at: '2026-09-12T11:00:00.000Z' });
    mockUpdateStatusPool({ existingRow, assignedToUserExists: true, updatedRow });
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'assignment_changed',
      recipients: [{ userId: 'employee-2', email: 'e2@macrocore.io', recipientRole: 'assignee', preferredLanguage: 'ar' }],
      diagnostic: null,
    });

    const req = makeReq({
      auth: { userId: 'admin-1', companyId: COMPANY_ID, role: 'admin' },
      params: { id: TICKET_ID },
      body: { assigned_to: 'employee-2' },
    });
    const res = makeRes();
    await updateStatus(req, res, NOOP_NEXT);

    expect(res.status).toHaveBeenCalledWith(200);
    const resolverArgs = mocks.resolveHelpdeskRecipients.mock.calls[0][0];
    expect(resolverArgs.event).toBe('assignment_changed');
    expect(resolverArgs.ticket.assigned_to).toBe('employee-2');
    expect(resolverArgs.newAssigneeUserId).toBe('employee-2');
    expect(resolverArgs.priority).toBe('medium');

    const updatedAtMs = new Date('2026-09-12T11:00:00.000Z').getTime();
    expect(mocks.enqueueEmail.mock.calls[0][0].dedupKey).toBe(`helpdesk_assignment_changed:${TICKET_ID}:employee-2:${updatedAtMs}`);
  });

  it('an assigned plain employee without view_hr_tickets on an HR ticket receives no assignment email (resolver still gets the correct HR context)', async () => {
    const existingRow = baseTicketRow({ id: TICKET_ID, assigned_to: null, request_type_is_hr_sensitive: true });
    const updatedRow = baseTicketRow({ id: TICKET_ID, assigned_to: 'employee-3', request_type_is_hr_sensitive: true });
    mockUpdateStatusPool({ existingRow, assignedToUserExists: true, updatedRow });
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'assignment_changed',
      recipients: [],
      diagnostic: { reason: 'new_assignee_ineligible', detail: 'missing view_hr_tickets' },
    });

    const req = makeReq({
      auth: { userId: 'admin-1', companyId: COMPANY_ID, role: 'admin' },
      params: { id: TICKET_ID },
      body: { assigned_to: 'employee-3' },
    });
    const res = makeRes();
    await updateStatus(req, res, NOOP_NEXT);

    const resolverArgs = mocks.resolveHelpdeskRecipients.mock.calls[0][0];
    expect(resolverArgs.ticket.request_type_is_hr_sensitive).toBe(true);
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });

  it('a compound category_id + assigned_to edit in the same PATCH passes the NEW category\'s HR flag to the resolver, not the old one', async () => {
    const existingRow = baseTicketRow({ id: TICKET_ID, assigned_to: null, category_is_hr_sensitive: false });
    const updatedRow = baseTicketRow({ id: TICKET_ID, assigned_to: 'employee-4', category_id: 'cat-hr' });
    mockUpdateStatusPool({ existingRow, categoryId: 'cat-hr', nextCategoryIsHrSensitive: true, assignedToUserExists: true, updatedRow });
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'assignment_changed',
      recipients: [],
      diagnostic: { reason: 'new_assignee_ineligible', detail: 'x' },
    });

    const req = makeReq({
      auth: { userId: 'admin-1', companyId: COMPANY_ID, role: 'admin' },
      params: { id: TICKET_ID },
      body: { category_id: 'cat-hr', assigned_to: 'employee-4' },
    });
    const res = makeRes();
    await updateStatus(req, res, NOOP_NEXT);

    const resolverArgs = mocks.resolveHelpdeskRecipients.mock.calls[0][0];
    expect(resolverArgs.ticket.category_is_hr_sensitive).toBe(true);
  });

  it('reassigning to the same current assignee sends zero email', async () => {
    const existingRow = baseTicketRow({ id: TICKET_ID, assigned_to: 'employee-5' });
    const updatedRow = baseTicketRow({ id: TICKET_ID, assigned_to: 'employee-5' });
    mockUpdateStatusPool({ existingRow, assignedToUserExists: true, updatedRow });

    const req = makeReq({
      auth: { userId: 'admin-1', companyId: COMPANY_ID, role: 'admin' },
      params: { id: TICKET_ID },
      body: { assigned_to: 'employee-5' },
    });
    const res = makeRes();
    await updateStatus(req, res, NOOP_NEXT);

    expect(mocks.resolveHelpdeskRecipients).not.toHaveBeenCalled();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });

  it('unassigning a ticket sends zero email', async () => {
    const existingRow = baseTicketRow({ id: TICKET_ID, assigned_to: 'employee-6' });
    const updatedRow = baseTicketRow({ id: TICKET_ID, assigned_to: null });
    mockUpdateStatusPool({ existingRow, updatedRow });
    // Real resolveHelpdeskRecipients returns zero recipients for a null
    // newAssigneeUserId (its own 'no_new_assignee' diagnostic) — mirrored
    // here since the resolver itself is mocked out in this file.
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'assignment_changed',
      recipients: [],
      diagnostic: { reason: 'no_new_assignee', detail: 'x' },
    });

    const req = makeReq({
      auth: { userId: 'admin-1', companyId: COMPANY_ID, role: 'admin' },
      params: { id: TICKET_ID },
      body: { assigned_to: null },
    });
    const res = makeRes();
    await updateStatus(req, res, NOOP_NEXT);

    expect(mocks.resolveHelpdeskRecipients).toHaveBeenCalledTimes(1);
    expect(mocks.resolveHelpdeskRecipients.mock.calls[0][0].newAssigneeUserId).toBeNull();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });

  it('a same-status resubmission sends zero email', async () => {
    const existingRow = baseTicketRow({ id: TICKET_ID, status: 'open' });
    const updatedRow = baseTicketRow({ id: TICKET_ID, status: 'open' });
    mockUpdateStatusPool({ existingRow, updatedRow });

    const req = makeReq({ auth: { userId: 'manager-1', companyId: COMPANY_ID, role: 'manager' }, params: { id: TICKET_ID }, body: { status: 'open' } });
    const res = makeRes();
    await updateStatus(req, res, NOOP_NEXT);

    expect(mocks.resolveHelpdeskRecipients).not.toHaveBeenCalled();
  });

  it('a priority-only update sends zero email', async () => {
    const existingRow = baseTicketRow({ id: TICKET_ID, priority: 'medium' });
    const updatedRow = baseTicketRow({ id: TICKET_ID, priority: 'urgent' });
    mockUpdateStatusPool({ existingRow, updatedRow });

    const req = makeReq({ auth: { userId: 'manager-1', companyId: COMPANY_ID, role: 'manager' }, params: { id: TICKET_ID }, body: { priority: 'urgent' } });
    const res = makeRes();
    await updateStatus(req, res, NOOP_NEXT);

    expect(mocks.resolveHelpdeskRecipients).not.toHaveBeenCalled();
  });

  it('a category-only update sends zero email', async () => {
    const existingRow = baseTicketRow({ id: TICKET_ID, category_id: null });
    const updatedRow = baseTicketRow({ id: TICKET_ID, category_id: 'cat-1' });
    mockUpdateStatusPool({ existingRow, categoryId: 'cat-1', nextCategoryIsHrSensitive: false, updatedRow });

    const req = makeReq({ auth: { userId: 'manager-1', companyId: COMPANY_ID, role: 'manager' }, params: { id: TICKET_ID }, body: { category_id: 'cat-1' } });
    const res = makeRes();
    await updateStatus(req, res, NOOP_NEXT);

    expect(mocks.resolveHelpdeskRecipients).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------
  // Full old/new status transition table (Phase C, point 5). Explicitly
  // decoupled from stampResolved — verified here by exercising real status
  // pairs end to end, not by asserting on stampResolved at all.
  // --------------------------------------------------------------------
  const TRANSITIONS: Array<{ old: string; next: string; expectedEvent: 'status_active' | 'resolved' | 'closed' | null }> = [
    { old: 'open', next: 'in_progress', expectedEvent: 'status_active' },
    { old: 'in_progress', next: 'open', expectedEvent: 'status_active' },
    { old: 'open', next: 'resolved', expectedEvent: 'resolved' },
    { old: 'in_progress', next: 'resolved', expectedEvent: 'resolved' },
    { old: 'open', next: 'closed', expectedEvent: 'closed' },
    { old: 'in_progress', next: 'closed', expectedEvent: 'closed' },
    { old: 'resolved', next: 'closed', expectedEvent: 'closed' },
    { old: 'resolved', next: 'open', expectedEvent: null },
    { old: 'resolved', next: 'in_progress', expectedEvent: null },
    { old: 'closed', next: 'open', expectedEvent: null },
    { old: 'closed', next: 'in_progress', expectedEvent: null },
    { old: 'closed', next: 'resolved', expectedEvent: null },
  ];

  it.each(TRANSITIONS)('status $old -> $next fires exactly the expected event ($expectedEvent)', async ({ old, next, expectedEvent }) => {
    const existingRow = baseTicketRow({ id: TICKET_ID, status: old });
    const updatedRow = baseTicketRow({ id: TICKET_ID, status: next, updated_at: '2026-09-12T12:00:00.000Z' });
    mockUpdateStatusPool({ existingRow, updatedRow });
    if (expectedEvent) {
      mocks.resolveHelpdeskRecipients.mockResolvedValue({
        event: expectedEvent,
        recipients: [{ userId: 'requester-1', email: 'req@macrocore.io', recipientRole: 'requester', preferredLanguage: 'en' }],
        diagnostic: null,
      });
    }

    const req = makeReq({ auth: { userId: 'manager-1', companyId: COMPANY_ID, role: 'manager' }, params: { id: TICKET_ID }, body: { status: next } });
    const res = makeRes();
    await updateStatus(req, res, NOOP_NEXT);

    if (expectedEvent === null) {
      expect(mocks.resolveHelpdeskRecipients).not.toHaveBeenCalled();
      expect(mocks.enqueueEmail).not.toHaveBeenCalled();
      return;
    }

    // Fires exactly once — never both 'resolved' and 'closed' for the same
    // transition (the double-fire bug the old stampResolved-keyed logic had
    // on open -> closed).
    expect(mocks.resolveHelpdeskRecipients).toHaveBeenCalledTimes(1);
    expect(mocks.resolveHelpdeskRecipients.mock.calls[0][0].event).toBe(expectedEvent);
    expect(mocks.enqueueEmail).toHaveBeenCalledTimes(1);
    const updatedAtMs = new Date('2026-09-12T12:00:00.000Z').getTime();
    expect(mocks.enqueueEmail.mock.calls[0][0].dedupKey).toBe(`helpdesk_${expectedEvent}:${TICKET_ID}:${updatedAtMs}`);
  });

  it('status_active (open -> in_progress) renders the fixed server-side bilingual label, never raw user-provided text', async () => {
    // subject: null keeps the rendered ticket ref to just the number, isolating
    // this assertion to the statusLabel fixation itself rather than also
    // depending on the (separately tested) subject-fragment behavior.
    const existingRow = baseTicketRow({ id: TICKET_ID, status: 'open', ticket_number: 'GEN-2609-0099', subject: null });
    const updatedRow = baseTicketRow({
      id: TICKET_ID,
      status: 'in_progress',
      ticket_number: 'GEN-2609-0099',
      subject: null,
      updated_at: '2026-09-12T13:00:00.000Z',
    });
    mockUpdateStatusPool({ existingRow, updatedRow });
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'status_active',
      recipients: [{ userId: 'requester-1', email: 'req@macrocore.io', recipientRole: 'requester', preferredLanguage: 'en' }],
      diagnostic: null,
    });

    const req = makeReq({ auth: { userId: 'manager-1', companyId: COMPANY_ID, role: 'manager' }, params: { id: TICKET_ID }, body: { status: 'in_progress' } });
    const res = makeRes();
    await updateStatus(req, res, NOOP_NEXT);

    const enqueueArgs = mocks.enqueueEmail.mock.calls[0][0];
    // The real ticketLifecycleEmailHtml() template, exercised end to end —
    // proves the fixed EN label ('in_progress') was used, not the raw
    // `status` string reflected back some other way.
    expect(enqueueArgs.subject).toBe('Ticket status updated #GEN-2609-0099');
    expect(enqueueArgs.html).toContain('status changed to "in_progress"');
  });

  it('the assignment/status dedup discriminator is the canonical epoch-ms number from the updated row\'s own updated_at, never a raw Date or date string', async () => {
    const existingRow = baseTicketRow({ id: TICKET_ID, status: 'open' });
    const isoUpdatedAt = '2026-09-12T14:23:45.678Z';
    const updatedRow = baseTicketRow({ id: TICKET_ID, status: 'closed', updated_at: isoUpdatedAt });
    mockUpdateStatusPool({ existingRow, updatedRow });
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'closed',
      recipients: [{ userId: 'requester-1', email: 'req@macrocore.io', recipientRole: 'requester', preferredLanguage: 'en' }],
      diagnostic: null,
    });

    const req = makeReq({ auth: { userId: 'manager-1', companyId: COMPANY_ID, role: 'manager' }, params: { id: TICKET_ID }, body: { status: 'closed' } });
    const res = makeRes();
    await updateStatus(req, res, NOOP_NEXT);

    const expectedMs = new Date(isoUpdatedAt).getTime();
    expect(Number.isFinite(expectedMs)).toBe(true);
    expect(mocks.enqueueEmail.mock.calls[0][0].dedupKey).toBe(`helpdesk_closed:${TICKET_ID}:${expectedMs}`);
  });

  it('a recipient-resolution failure never fails updateStatus()', async () => {
    const existingRow = baseTicketRow({ id: TICKET_ID, status: 'open' });
    const updatedRow = baseTicketRow({ id: TICKET_ID, status: 'resolved' });
    mockUpdateStatusPool({ existingRow, updatedRow });
    mocks.resolveHelpdeskRecipients.mockRejectedValue(new Error('boom'));

    const req = makeReq({ auth: { userId: 'manager-1', companyId: COMPANY_ID, role: 'manager' }, params: { id: TICKET_ID }, body: { status: 'resolved' } });
    const res = makeRes();
    await updateStatus(req, res, NOOP_NEXT);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body.success).toBe(true);
  });

  it('an enqueue failure never fails updateStatus()', async () => {
    const existingRow = baseTicketRow({ id: TICKET_ID, status: 'open' });
    const updatedRow = baseTicketRow({ id: TICKET_ID, status: 'resolved' });
    mockUpdateStatusPool({ existingRow, updatedRow });
    mocks.resolveHelpdeskRecipients.mockResolvedValue({
      event: 'resolved',
      recipients: [{ userId: 'requester-1', email: 'req@macrocore.io', recipientRole: 'requester', preferredLanguage: 'en' }],
      diagnostic: null,
    });
    mocks.enqueueEmail.mockRejectedValue(new Error('boom'));

    const req = makeReq({ auth: { userId: 'manager-1', companyId: COMPANY_ID, role: 'manager' }, params: { id: TICKET_ID }, body: { status: 'resolved' } });
    const res = makeRes();
    await updateStatus(req, res, NOOP_NEXT);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body.success).toBe(true);
  });
});
