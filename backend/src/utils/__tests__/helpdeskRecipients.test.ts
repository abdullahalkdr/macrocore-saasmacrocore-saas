import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same mocking shape itsmAuthorization.test.ts already uses: mock the pool
// and the permissions layer, but import the REAL canAccessTicket from
// itsmApprovals.ts — this resolver reuses that function rather than
// reimplementing HR-sensitivity/ticket-access, and these tests prove that by
// exercising the real function, not a stand-in.
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  hasPermission: vi.fn(),
  usersWithPermission: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: mocks.query } }));
vi.mock('../permissions', () => ({
  hasPermission: mocks.hasPermission,
  usersWithPermission: mocks.usersWithPermission,
}));

import { resolveHelpdeskRecipients, type ResolveHelpdeskRecipientsParams } from '../helpdeskRecipients';
import type { ItsmTicketAccessContext } from '../itsmApprovals';

const COMPANY_ID = 'company-1';
const OTHER_COMPANY_ID = 'company-2';
const REQUESTER_ID = 'user-requester';

const nonHrTicket: ItsmTicketAccessContext = {
  request_type_id: 'request-type-1',
  created_by: REQUESTER_ID,
  category: 'general',
  category_is_hr_sensitive: false,
  request_type_is_hr_sensitive: false,
};

const hrTicket: ItsmTicketAccessContext = {
  ...nonHrTicket,
  request_type_is_hr_sensitive: true,
};

interface FakeUser {
  id: string;
  email: string;
  status: string;
  role: string;
  company_id: string;
}

function user(over: Partial<FakeUser> & { id: string }): FakeUser {
  return {
    email: `${over.id}@macrocore.io`,
    status: 'active',
    role: 'employee',
    company_id: COMPANY_ID,
    ...over,
  };
}

interface MockWorld {
  users?: FakeUser[];
  requesterEmployeeId?: string | null;
  requesterDepartmentId?: string | null;
  departmentManagerEmployeeId?: string | null;
  managerUserId?: string | null;
  slaEscalateToRole?: string | null;
  escalationRoleUserIdsInOrder?: string[];
  adminManagerUserIdsInOrder?: string[];
}

// Routes every pool.query() call this module can issue to canned data, by
// matching a unique substring of the SQL text (same technique
// itsmAuthorization.test.ts uses). Any query shape not configured throws,
// so an unexpected/unaccounted-for query fails the test loudly instead of
// silently returning {rows: []}.
function installMockWorld(world: MockWorld) {
  const usersById = new Map((world.users ?? []).map((u) => [u.id, u]));

  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT id, email, status, role, company_id FROM users WHERE id = $1 AND company_id = $2')) {
      const [id, companyId] = params as [string, string];
      const u = usersById.get(id);
      if (!u || u.company_id !== companyId) return { rows: [] };
      return { rows: [u] };
    }
    if (sql.includes('SELECT employee_id FROM users WHERE id = $1 AND company_id = $2')) {
      const [id] = params as [string];
      if (id !== REQUESTER_ID) return { rows: [] };
      return { rows: world.requesterEmployeeId ? [{ employee_id: world.requesterEmployeeId }] : [] };
    }
    if (sql.includes('SELECT department_id FROM employees WHERE id = $1 AND company_id = $2')) {
      return { rows: world.requesterDepartmentId ? [{ department_id: world.requesterDepartmentId }] : [] };
    }
    if (sql.includes('SELECT manager_id FROM departments WHERE id = $1 AND company_id = $2')) {
      return { rows: world.departmentManagerEmployeeId ? [{ manager_id: world.departmentManagerEmployeeId }] : [] };
    }
    if (sql.includes('SELECT id FROM users WHERE employee_id = $1 AND company_id = $2')) {
      return { rows: world.managerUserId ? [{ id: world.managerUserId }] : [] };
    }
    if (sql.includes('SELECT escalate_to_role FROM sla_policies')) {
      return { rows: world.slaEscalateToRole ? [{ escalate_to_role: world.slaEscalateToRole }] : [] };
    }
    if (sql.includes('role = $2 ORDER BY created_at ASC')) {
      return { rows: (world.escalationRoleUserIdsInOrder ?? []).map((id) => ({ id })) };
    }
    if (sql.includes('role = ANY($2::text[]) ORDER BY created_at ASC')) {
      return { rows: (world.adminManagerUserIdsInOrder ?? []).map((id) => ({ id })) };
    }
    throw new Error(`Unexpected query in helpdeskRecipients test: ${sql}`);
  });
}

function baseParams(overrides: Partial<ResolveHelpdeskRecipientsParams> = {}): ResolveHelpdeskRecipientsParams {
  return {
    event: 'created',
    companyId: COMPANY_ID,
    ticket: nonHrTicket,
    priority: 'medium',
    ...overrides,
  };
}

function calledSql(): string {
  return mocks.query.mock.calls.map(([sql]) => sql as string).join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(false);
  mocks.usersWithPermission.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Requester-only events: created, staff_reply, status_active, resolved, closed
// ---------------------------------------------------------------------------
describe('requester-only events', () => {
  const events: ResolveHelpdeskRecipientsParams['event'][] = ['created', 'staff_reply', 'status_active', 'resolved', 'closed'];

  it('resolve the requester as the sole recipient when eligible', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID })] });
    for (const event of events) {
      const result = await resolveHelpdeskRecipients(baseParams({ event }));
      expect(result.diagnostic).toBeNull();
      expect(result.recipients).toEqual([{ userId: REQUESTER_ID, email: `${REQUESTER_ID}@macrocore.io`, recipientRole: 'requester' }]);
    }
  });

  it('returns an explicit no-recipient diagnostic (not an exception) when the requester itself is ineligible', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID, status: 'suspended' })] });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'created' }));
    expect(result.recipients).toEqual([]);
    expect(result.diagnostic).toEqual({
      reason: 'requester_ineligible',
      detail: expect.stringContaining(REQUESTER_ID),
    });
  });

  it('rejects a requester with no usable email', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID, email: '  ' })] });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'resolved' }));
    expect(result.recipients).toEqual([]);
    expect(result.diagnostic?.reason).toBe('requester_ineligible');
  });

  it('rejects a requester whose user row belongs to a different tenant than the one being resolved for', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID, company_id: OTHER_COMPANY_ID })] });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'closed' }));
    expect(result.recipients).toEqual([]);
    expect(result.diagnostic?.reason).toBe('requester_ineligible');
  });
});

// ---------------------------------------------------------------------------
// assignment_changed — new assignee only, never a fallback substitute
// ---------------------------------------------------------------------------
describe('assignment_changed', () => {
  it('notifies only the eligible new assignee', async () => {
    // role: 'manager' — under the real, unchanged canAccessTicket(), a plain
    // 'employee' who isn't the ticket creator can never access it (Option A);
    // 'manager'/'admin' is the role that can currently open a ticket it
    // doesn't own, so that's what a genuinely-eligible fixture needs here.
    installMockWorld({ users: [user({ id: REQUESTER_ID }), user({ id: 'agent-1', role: 'manager' })] });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'assignment_changed', newAssigneeUserId: 'agent-1' }));
    expect(result.diagnostic).toBeNull();
    expect(result.recipients).toEqual([{ userId: 'agent-1', email: 'agent-1@macrocore.io', recipientRole: 'assignee' }]);
  });

  it('sends to nobody, with a diagnostic, when the new assignee is ineligible — and never substitutes a fallback recipient', async () => {
    // 'agent-1' is a plain employee who is NOT the ticket creator, on an
    // HR-sensitive ticket — the known canAccessTicket() gap (Option A).
    installMockWorld({ users: [user({ id: REQUESTER_ID }), user({ id: 'agent-1', role: 'employee' })] });
    const result = await resolveHelpdeskRecipients(
      baseParams({ event: 'assignment_changed', ticket: hrTicket, newAssigneeUserId: 'agent-1' })
    );
    expect(result.recipients).toEqual([]);
    expect(result.diagnostic?.reason).toBe('new_assignee_ineligible');
    // No fallback ladder query of any kind was ever issued for this event.
    expect(calledSql()).not.toMatch(/departments|sla_policies|role = ANY/i);
  });

  it('returns a diagnostic when there is no new assignee to notify at all', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID })] });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'assignment_changed', newAssigneeUserId: null }));
    expect(result.recipients).toEqual([]);
    expect(result.diagnostic?.reason).toBe('no_new_assignee');
  });
});

// ---------------------------------------------------------------------------
// reopened — requester + eligible current assignee, no substitution
// ---------------------------------------------------------------------------
describe('reopened', () => {
  it('notifies the requester and the eligible current assignee together', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID }), user({ id: 'agent-1', role: 'manager' })] });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'reopened', currentAssigneeUserId: 'agent-1' }));
    expect(result.diagnostic).toBeNull();
    expect(result.recipients).toEqual([
      { userId: REQUESTER_ID, email: `${REQUESTER_ID}@macrocore.io`, recipientRole: 'requester' },
      { userId: 'agent-1', email: 'agent-1@macrocore.io', recipientRole: 'assignee' },
    ]);
  });

  it('still notifies the requester alone when the current assignee is ineligible — no fallback substitute for the assignee slot', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID }), user({ id: 'agent-1', status: 'inactive' })] });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'reopened', currentAssigneeUserId: 'agent-1' }));
    expect(result.diagnostic).toBeNull();
    expect(result.recipients).toEqual([{ userId: REQUESTER_ID, email: `${REQUESTER_ID}@macrocore.io`, recipientRole: 'requester' }]);
    // The fallback ladder must never be consulted for the assignee slot here.
    expect(calledSql()).not.toMatch(/departments|sla_policies|role = ANY/i);
  });

  it('works with no current assignee at all (ticket was never assigned) — requester only', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID })] });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'reopened', currentAssigneeUserId: null }));
    expect(result.recipients).toEqual([{ userId: REQUESTER_ID, email: `${REQUESTER_ID}@macrocore.io`, recipientRole: 'requester' }]);
  });

  it('returns an explicit no-recipient diagnostic when both the requester and the assignee are ineligible', async () => {
    installMockWorld({
      users: [user({ id: REQUESTER_ID, status: 'suspended' }), user({ id: 'agent-1', status: 'inactive' })],
    });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'reopened', currentAssigneeUserId: 'agent-1' }));
    expect(result.recipients).toEqual([]);
    expect(result.diagnostic?.reason).toBe('no_eligible_recipient');
  });
});

// ---------------------------------------------------------------------------
// requester_reply / sla_warning / sla_breach — assignee first, then the full
// operational fallback ladder (department manager -> escalation role -> any
// eligible admin/manager -> nobody).
// ---------------------------------------------------------------------------
describe('requester_reply / sla_warning / sla_breach — assignee-first, then the fallback ladder', () => {
  const events: ResolveHelpdeskRecipientsParams['event'][] = ['requester_reply', 'sla_warning', 'sla_breach'];

  it('goes straight to the eligible current assignee and never touches the ladder', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID }), user({ id: 'agent-1', role: 'manager' })] });
    for (const event of events) {
      const result = await resolveHelpdeskRecipients(baseParams({ event, currentAssigneeUserId: 'agent-1' }));
      expect(result.diagnostic).toBeNull();
      expect(result.recipients).toEqual([{ userId: 'agent-1', email: 'agent-1@macrocore.io', recipientRole: 'assignee' }]);
    }
    expect(calledSql()).not.toMatch(/departments|sla_policies|role = ANY/i);
  });

  it('falls back to the department manager (step 1) when there is no assignee', async () => {
    installMockWorld({
      users: [user({ id: REQUESTER_ID }), user({ id: 'mgr-1', role: 'manager' })],
      requesterEmployeeId: 'emp-requester',
      requesterDepartmentId: 'dept-1',
      departmentManagerEmployeeId: 'emp-mgr-1',
      managerUserId: 'mgr-1',
    });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'requester_reply', currentAssigneeUserId: null }));
    expect(result.diagnostic).toBeNull();
    expect(result.recipients).toEqual([{ userId: 'mgr-1', email: 'mgr-1@macrocore.io', recipientRole: 'department_manager' }]);
  });

  it('falls back to the department manager when the current assignee is ineligible (not merely absent)', async () => {
    installMockWorld({
      users: [user({ id: REQUESTER_ID }), user({ id: 'agent-1', status: 'inactive' }), user({ id: 'mgr-1', role: 'manager' })],
      requesterEmployeeId: 'emp-requester',
      requesterDepartmentId: 'dept-1',
      departmentManagerEmployeeId: 'emp-mgr-1',
      managerUserId: 'mgr-1',
    });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'sla_warning', currentAssigneeUserId: 'agent-1' }));
    expect(result.recipients).toEqual([{ userId: 'mgr-1', email: 'mgr-1@macrocore.io', recipientRole: 'department_manager' }]);
  });

  it('a service-request type never affects department-manager resolution — only the requester\'s own employee/department chain is queried', async () => {
    installMockWorld({
      users: [user({ id: REQUESTER_ID }), user({ id: 'mgr-1', role: 'manager' })],
      requesterEmployeeId: 'emp-requester',
      requesterDepartmentId: 'dept-1',
      departmentManagerEmployeeId: 'emp-mgr-1',
      managerUserId: 'mgr-1',
    });
    await resolveHelpdeskRecipients(baseParams({ event: 'sla_breach', currentAssigneeUserId: null }));
    expect(calledSql()).not.toMatch(/service_request_types/i);
  });

  it('falls back to the escalation-role holder (step 2) when there is no department manager', async () => {
    installMockWorld({
      users: [user({ id: REQUESTER_ID }), user({ id: 'esc-1', role: 'admin' })],
      requesterEmployeeId: 'emp-requester',
      requesterDepartmentId: null, // requester's employee has no department -> step 1 yields nothing
      slaEscalateToRole: 'admin',
      escalationRoleUserIdsInOrder: ['esc-1'],
    });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'requester_reply', currentAssigneeUserId: null }));
    expect(result.recipients).toEqual([{ userId: 'esc-1', email: 'esc-1@macrocore.io', recipientRole: 'escalation_role' }]);
  });

  it('walks past an ineligible earlier escalation-role holder to the next one, in the existing deterministic (created_at ASC) order', async () => {
    installMockWorld({
      users: [
        user({ id: REQUESTER_ID }),
        user({ id: 'esc-1', role: 'admin', status: 'inactive' }), // earliest-created, but inactive
        user({ id: 'esc-2', role: 'admin' }), // next in order, eligible
      ],
      requesterEmployeeId: null, // no linked employee -> step 1 yields nothing
      slaEscalateToRole: 'admin',
      escalationRoleUserIdsInOrder: ['esc-1', 'esc-2'],
    });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'sla_warning', currentAssigneeUserId: null }));
    expect(result.recipients).toEqual([{ userId: 'esc-2', email: 'esc-2@macrocore.io', recipientRole: 'escalation_role' }]);
  });

  it('defaults the escalation role to admin when the company has no sla_policies row for this priority', async () => {
    installMockWorld({
      users: [user({ id: REQUESTER_ID }), user({ id: 'esc-1', role: 'admin' })],
      requesterEmployeeId: null,
      slaEscalateToRole: null, // no row -> COALESCE-style default to 'admin'
      escalationRoleUserIdsInOrder: ['esc-1'],
    });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'sla_breach', currentAssigneeUserId: null }));
    expect(result.recipients).toEqual([{ userId: 'esc-1', email: 'esc-1@macrocore.io', recipientRole: 'escalation_role' }]);
  });

  it('falls back to EVERY eligible admin/manager (step 3, plural) when steps 1 and 2 both yield nothing', async () => {
    installMockWorld({
      users: [
        user({ id: REQUESTER_ID }),
        user({ id: 'admin-1', role: 'admin' }),
        user({ id: 'admin-2', role: 'manager', status: 'inactive' }), // ineligible, must be skipped
        user({ id: 'admin-3', role: 'manager' }),
      ],
      requesterEmployeeId: null,
      slaEscalateToRole: 'admin',
      escalationRoleUserIdsInOrder: [], // no holder of the escalation role at all
      adminManagerUserIdsInOrder: ['admin-1', 'admin-2', 'admin-3'],
    });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'requester_reply', currentAssigneeUserId: null }));
    expect(result.diagnostic).toBeNull();
    expect(result.recipients).toEqual([
      { userId: 'admin-1', email: 'admin-1@macrocore.io', recipientRole: 'admin_manager_fallback' },
      { userId: 'admin-3', email: 'admin-3@macrocore.io', recipientRole: 'admin_manager_fallback' },
    ]);
  });

  it('deduplicates recipients deterministically if the same user id is ever returned twice by the fallback source query', async () => {
    installMockWorld({
      users: [user({ id: REQUESTER_ID }), user({ id: 'admin-1', role: 'admin' })],
      requesterEmployeeId: null,
      slaEscalateToRole: 'admin',
      escalationRoleUserIdsInOrder: [],
      adminManagerUserIdsInOrder: ['admin-1', 'admin-1'],
    });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'sla_warning', currentAssigneeUserId: null }));
    expect(result.recipients).toEqual([{ userId: 'admin-1', email: 'admin-1@macrocore.io', recipientRole: 'admin_manager_fallback' }]);
  });

  it('produces an explicit, testable no-recipient outcome (not an exception) when the entire ladder is exhausted', async () => {
    installMockWorld({
      users: [user({ id: REQUESTER_ID })],
      requesterEmployeeId: null,
      slaEscalateToRole: 'admin',
      escalationRoleUserIdsInOrder: [],
      adminManagerUserIdsInOrder: [],
    });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'sla_breach', currentAssigneeUserId: null }));
    expect(result.recipients).toEqual([]);
    expect(result.diagnostic).toEqual({ reason: 'fallback_exhausted', detail: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------
// escalation — explicit target first, otherwise resume the ladder AT STEP 2
// (department manager is deliberately skipped for this event).
// ---------------------------------------------------------------------------
describe('escalation', () => {
  it('notifies the explicit escalation target when eligible, without consulting the ladder at all', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID }), user({ id: 'esc-target', role: 'admin' })] });
    const result = await resolveHelpdeskRecipients(
      baseParams({ event: 'escalation', explicitEscalationTargetUserId: 'esc-target' })
    );
    expect(result.diagnostic).toBeNull();
    expect(result.recipients).toEqual([{ userId: 'esc-target', email: 'esc-target@macrocore.io', recipientRole: 'escalation_target' }]);
    expect(calledSql()).not.toMatch(/departments|sla_policies|role = ANY/i);
  });

  it('resumes the ladder at the escalation-role step (2) when the explicit target is ineligible — department manager (step 1) is never consulted', async () => {
    installMockWorld({
      users: [user({ id: REQUESTER_ID }), user({ id: 'esc-target', status: 'inactive' }), user({ id: 'esc-1', role: 'admin' })],
      slaEscalateToRole: 'admin',
      escalationRoleUserIdsInOrder: ['esc-1'],
    });
    const result = await resolveHelpdeskRecipients(
      baseParams({ event: 'escalation', explicitEscalationTargetUserId: 'esc-target' })
    );
    expect(result.diagnostic).toBeNull();
    expect(result.recipients).toEqual([{ userId: 'esc-1', email: 'esc-1@macrocore.io', recipientRole: 'escalation_role' }]);
    // Step 1's queries (employees/departments) must never fire for escalation.
    expect(calledSql()).not.toMatch(/SELECT department_id FROM employees|SELECT manager_id FROM departments/);
  });

  it('falls through to the admin/manager fallback (step 3) when no explicit target and no escalation-role holder are eligible', async () => {
    installMockWorld({
      users: [user({ id: REQUESTER_ID }), user({ id: 'admin-1', role: 'admin' })],
      slaEscalateToRole: 'admin',
      escalationRoleUserIdsInOrder: [],
      adminManagerUserIdsInOrder: ['admin-1'],
    });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'escalation', explicitEscalationTargetUserId: null }));
    expect(result.recipients).toEqual([{ userId: 'admin-1', email: 'admin-1@macrocore.io', recipientRole: 'admin_manager_fallback' }]);
  });

  it('returns an explicit no-recipient diagnostic when everything is exhausted', async () => {
    installMockWorld({
      users: [user({ id: REQUESTER_ID })],
      slaEscalateToRole: 'admin',
      escalationRoleUserIdsInOrder: [],
      adminManagerUserIdsInOrder: [],
    });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'escalation', explicitEscalationTargetUserId: null }));
    expect(result.recipients).toEqual([]);
    expect(result.diagnostic?.reason).toBe('fallback_exhausted');
  });
});

// ---------------------------------------------------------------------------
// Recipient eligibility — each rejection reason proven independently, and
// proof that HR-sensitivity/ticket-access is enforced via the real,
// unmodified canAccessTicket() (no second/duplicated definition here).
// ---------------------------------------------------------------------------
describe('recipient eligibility rules', () => {
  it('rejects an inactive/suspended candidate', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID }), user({ id: 'agent-1', status: 'suspended' })] });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'assignment_changed', newAssigneeUserId: 'agent-1' }));
    expect(result.recipients).toEqual([]);
  });

  it('rejects a candidate belonging to a different tenant', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID }), user({ id: 'agent-1', company_id: OTHER_COMPANY_ID })] });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'assignment_changed', newAssigneeUserId: 'agent-1' }));
    expect(result.recipients).toEqual([]);
  });

  it('rejects a candidate with no usable (blank) email', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID }), user({ id: 'agent-1', email: '   ' })] });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'assignment_changed', newAssigneeUserId: 'agent-1' }));
    expect(result.recipients).toEqual([]);
  });

  it('trims harmless surrounding whitespace from an otherwise-usable email before returning it', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID }), user({ id: 'agent-1', role: 'manager', email: '  agent-1@macrocore.io  ' })] });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'assignment_changed', newAssigneeUserId: 'agent-1' }));
    expect(result.recipients).toEqual([{ userId: 'agent-1', email: 'agent-1@macrocore.io', recipientRole: 'assignee' }]);
  });

  it('rejects the requester themselves as an assignee/fallback candidate (excludeSelf)', async () => {
    // Data shouldn't normally allow assigned_to === created_by, but the rule
    // must hold even if it ever does.
    installMockWorld({ users: [user({ id: REQUESTER_ID })] });
    const result = await resolveHelpdeskRecipients(baseParams({ event: 'assignment_changed', newAssigneeUserId: REQUESTER_ID }));
    expect(result.recipients).toEqual([]);
    expect(result.diagnostic?.reason).toBe('new_assignee_ineligible');
  });

  it('rejects a plain-employee candidate who is not the ticket creator on an HR-sensitive ticket (the known canAccessTicket() gap, Option A)', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID }), user({ id: 'agent-1', role: 'employee' })] });
    const result = await resolveHelpdeskRecipients(
      baseParams({ event: 'assignment_changed', ticket: hrTicket, newAssigneeUserId: 'agent-1' })
    );
    expect(result.recipients).toEqual([]);
    expect(mocks.hasPermission).not.toHaveBeenCalled(); // employee role short-circuits before the HR permission check
  });

  it('rejects an admin/manager candidate on an HR-sensitive ticket unless they hold view_hr_tickets', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID }), user({ id: 'admin-1', role: 'admin' })] });
    mocks.hasPermission.mockResolvedValueOnce(false);
    const denied = await resolveHelpdeskRecipients(
      baseParams({ event: 'assignment_changed', ticket: hrTicket, newAssigneeUserId: 'admin-1' })
    );
    expect(denied.recipients).toEqual([]);
    expect(mocks.hasPermission).toHaveBeenCalledWith('admin-1', 'view_hr_tickets');

    mocks.hasPermission.mockResolvedValueOnce(true);
    const allowed = await resolveHelpdeskRecipients(
      baseParams({ event: 'assignment_changed', ticket: hrTicket, newAssigneeUserId: 'admin-1' })
    );
    expect(allowed.recipients).toEqual([{ userId: 'admin-1', email: 'admin-1@macrocore.io', recipientRole: 'assignee' }]);
  });

  it('never invents a new permission key — HR gating always calls hasPermission with view_hr_tickets, the existing key', async () => {
    installMockWorld({ users: [user({ id: REQUESTER_ID }), user({ id: 'admin-1', role: 'admin' })] });
    mocks.hasPermission.mockResolvedValueOnce(true);
    await resolveHelpdeskRecipients(baseParams({ event: 'assignment_changed', ticket: hrTicket, newAssigneeUserId: 'admin-1' }));
    for (const call of mocks.hasPermission.mock.calls) {
      expect(call[1]).toBe('view_hr_tickets');
    }
  });
});
