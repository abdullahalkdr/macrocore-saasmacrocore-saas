import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  hasPermission: vi.fn(),
  usersWithPermission: vi.fn(),
  notifyRoles: vi.fn(),
  notifyUsers: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: mocks.query } }));
vi.mock('../permissions', () => ({
  hasPermission: mocks.hasPermission,
  usersWithPermission: mocks.usersWithPermission,
}));
vi.mock('../notifications', () => ({
  notifyRoles: mocks.notifyRoles,
  notifyUsers: mocks.notifyUsers,
}));

import {
  canAccessTicket,
  isEligibleForItsmStep,
  isHrSensitiveTicket,
  notifyItsmStepPending,
  resolveItsmNotificationRecipients,
  type ItsmTicketAccessContext,
  type StepEligibility,
  type WorkflowStepDef,
} from '../itsmApprovals';

const nonHrTicket: ItsmTicketAccessContext = {
  request_type_id: 'request-type',
  created_by: 'maker',
  category: 'general',
  category_is_hr_sensitive: false,
  request_type_is_hr_sensitive: false,
};

const hrTicket: ItsmTicketAccessContext = {
  ...nonHrTicket,
  category: 'general',
  request_type_is_hr_sensitive: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.hasPermission.mockResolvedValue(false);
  mocks.usersWithPermission.mockResolvedValue([]);
});

describe('ITSM HR authorization policy', () => {
  it('recognizes every supported HR-sensitivity signal', () => {
    expect(isHrSensitiveTicket({ ...nonHrTicket, category: 'payroll' })).toBe(true);
    expect(isHrSensitiveTicket({ ...nonHrTicket, category_is_hr_sensitive: true })).toBe(true);
    expect(isHrSensitiveTicket({ ...nonHrTicket, request_type_is_hr_sensitive: true })).toBe(true);
    expect(isHrSensitiveTicket(nonHrTicket)).toBe(false);
  });

  it('keeps requester access, ordinary employee isolation, and manager/admin non-HR access unchanged', async () => {
    await expect(canAccessTicket({ userId: 'maker', role: 'employee' }, hrTicket)).resolves.toBe(true);
    await expect(canAccessTicket({ userId: 'coworker', role: 'employee' }, nonHrTicket)).resolves.toBe(false);
    await expect(canAccessTicket({ userId: 'manager', role: 'manager' }, nonHrTicket)).resolves.toBe(true);
    await expect(canAccessTicket({ userId: 'admin', role: 'admin' }, nonHrTicket)).resolves.toBe(true);
    expect(mocks.hasPermission).not.toHaveBeenCalled();
  });

  it('requires the effective HR permission even for an admin', async () => {
    await expect(canAccessTicket({ userId: 'admin', role: 'admin' }, hrTicket)).resolves.toBe(false);
    mocks.hasPermission.mockResolvedValueOnce(true);
    await expect(canAccessTicket({ userId: 'admin', role: 'admin' }, hrTicket)).resolves.toBe(true);
    expect(mocks.hasPermission).toHaveBeenCalledWith('admin', 'view_hr_tickets');
  });

  it('applies maker-checker and the HR gate before the admin safety valve or resolved-user match', async () => {
    const fallback: StepEligibility = { userIds: [], allowAnyManager: true };
    const specific: StepEligibility = { userIds: ['approver'], allowAnyManager: false };

    await expect(isEligibleForItsmStep({ userId: 'maker', role: 'admin' }, fallback, hrTicket)).resolves.toBe(false);
    await expect(isEligibleForItsmStep({ userId: 'admin', role: 'admin' }, fallback, hrTicket)).resolves.toBe(false);
    await expect(isEligibleForItsmStep({ userId: 'approver', role: 'employee' }, specific, hrTicket)).resolves.toBe(false);

    mocks.hasPermission.mockResolvedValue(true);
    await expect(isEligibleForItsmStep({ userId: 'admin', role: 'admin' }, fallback, hrTicket)).resolves.toBe(true);
    await expect(isEligibleForItsmStep({ userId: 'approver', role: 'employee' }, specific, hrTicket)).resolves.toBe(true);
  });

  it('does not add an HR-permission query to non-HR step eligibility', async () => {
    const fallback: StepEligibility = { userIds: [], allowAnyManager: true };
    await expect(isEligibleForItsmStep({ userId: 'admin', role: 'admin' }, fallback, nonHrTicket)).resolves.toBe(true);
    expect(mocks.hasPermission).not.toHaveBeenCalled();
  });

  // Chat 3C — assigned-employee access prerequisite. canAccessTicket() now also
  // grants access to a plain employee who is the ticket's assigned_to, subject to
  // the same HR gate every other non-creator already goes through.
  describe('assigned-employee access (Chat 3C)', () => {
    const assignedNonHrTicket: ItsmTicketAccessContext = { ...nonHrTicket, assigned_to: 'assignee' };
    const assignedHrTicket: ItsmTicketAccessContext = { ...hrTicket, assigned_to: 'assignee' };

    it('grants a plain employee assignee access to a non-HR ticket they did not create', async () => {
      await expect(canAccessTicket({ userId: 'assignee', role: 'employee' }, assignedNonHrTicket)).resolves.toBe(true);
      expect(mocks.hasPermission).not.toHaveBeenCalled();
    });

    it('still denies an unassigned bystander employee on the same ticket', async () => {
      await expect(canAccessTicket({ userId: 'bystander', role: 'employee' }, assignedNonHrTicket)).resolves.toBe(false);
    });

    it('denies the assigned employee on an HR-sensitive ticket without view_hr_tickets', async () => {
      await expect(canAccessTicket({ userId: 'assignee', role: 'employee' }, assignedHrTicket)).resolves.toBe(false);
      expect(mocks.hasPermission).toHaveBeenCalledWith('assignee', 'view_hr_tickets');
    });

    it('grants the assigned employee an HR-sensitive ticket once they hold view_hr_tickets', async () => {
      mocks.hasPermission.mockResolvedValueOnce(true);
      await expect(canAccessTicket({ userId: 'assignee', role: 'employee' }, assignedHrTicket)).resolves.toBe(true);
    });

    it('leaves manager/admin behavior as an assignee unchanged — they already had access regardless of assignment', async () => {
      await expect(canAccessTicket({ userId: 'assignee', role: 'manager' }, assignedNonHrTicket)).resolves.toBe(true);
      await expect(canAccessTicket({ userId: 'assignee', role: 'admin' }, assignedNonHrTicket)).resolves.toBe(true);
    });
  });
});

describe('ITSM approval notification recipients', () => {
  it('filters specifically resolved HR recipients by effective permission and excludes the maker', async () => {
    mocks.usersWithPermission.mockResolvedValue(['allowed', 'maker']);
    await expect(
      resolveItsmNotificationRecipients(
        'company',
        { userIds: ['allowed', 'blocked', 'maker'], allowAnyManager: true },
        hrTicket
      )
    ).resolves.toEqual(['allowed']);
  });

  it('filters HR fallback recipients to active permitted admins/managers', async () => {
    mocks.usersWithPermission.mockResolvedValue(['admin', 'manager', 'employee', 'maker']);
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'admin' }, { id: 'manager' }, { id: 'maker' }] });

    await expect(
      resolveItsmNotificationRecipients('company', { userIds: [], allowAnyManager: true }, hrTicket)
    ).resolves.toEqual(['admin', 'manager']);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("role = ANY($2::text[])"), [
      'company',
      ['admin', 'manager'],
      ['admin', 'manager', 'employee', 'maker'],
    ]);
  });

  it('returns null for non-HR so the existing notification path remains in control', async () => {
    await expect(
      resolveItsmNotificationRecipients('company', { userIds: ['approver'], allowAnyManager: false }, nonHrTicket)
    ).resolves.toBeNull();
    expect(mocks.usersWithPermission).not.toHaveBeenCalled();
  });

  it('uses the permission-filtered HR list instead of the unfiltered role fallback', async () => {
    const step: WorkflowStepDef = {
      step_number: 1,
      approver_type: 'department_manager',
      approver_value: null,
      approver_job_role_id: null,
      step_label: 'المدير',
      step_label_en: 'Manager',
    };
    mocks.usersWithPermission.mockResolvedValue(['permitted-admin']);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT department_id FROM employees')) return { rows: [] };
      if (sql.includes('FROM support_tickets t')) return { rows: [hrTicket] };
      if (sql.includes('role = ANY($2::text[])')) return { rows: [{ id: 'permitted-admin' }] };
      if (sql.includes('SELECT name FROM employees')) return { rows: [{ name: 'Requester' }] };
      return { rows: [] };
    });

    await notifyItsmStepPending('company', 'ticket', 'requester-employee', step, 'approval', 'APR-1');

    expect(mocks.notifyUsers).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['permitted-admin'] }));
    expect(mocks.notifyRoles).not.toHaveBeenCalled();
  });
});

describe('Stage H controller wiring', () => {
  const approvalsSource = fs.readFileSync(path.join(__dirname, '../../controllers/approvals.controller.ts'), 'utf8');
  const supportSource = fs.readFileSync(path.join(__dirname, '../../controllers/supportTickets.controller.ts'), 'utf8');
  const itsmSource = fs.readFileSync(path.join(__dirname, '../itsmApprovals.ts'), 'utf8');

  it('uses the shared eligibility guard in pending-list, action, and summary paths', () => {
    expect((approvalsSource.match(/isEligibleForItsmStep\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(approvalsSource).not.toContain('isEligible(req.auth!, eligibility)');
  });

  it('authorizes an ITSM summary before reading its approval log or record details', () => {
    const summary = approvalsSource.slice(approvalsSource.indexOf('export const getApprovalSummary'));
    const accessIndex = summary.indexOf('if (!(await canAccessTicket(req.auth!, ticket)) && !isPendingApprover)');
    const denyIndex = summary.indexOf("throw new AppError(404, 'Ticket not found')", accessIndex);
    const logIndex = summary.indexOf('FROM approval_steps_log');
    const detailIndex = summary.indexOf('buildRecordDetail(');
    expect(accessIndex).toBeGreaterThan(-1);
    expect(denyIndex).toBeGreaterThan(-1);
    expect(logIndex).toBeGreaterThan(denyIndex);
    expect(detailIndex).toBeGreaterThan(logIndex);
  });

  it('uses the same guarded pending-approver decision in the ticket-detail summary', () => {
    const detailSummary = itsmSource.slice(itsmSource.indexOf('export async function getItsmApprovalSummary'));
    expect(detailSummary).toContain('isPendingApproverForMe = await isEligibleForItsmStep(currentUser, eligibility, ticket);');
  });

  it('keeps one shared ticket-access policy instead of a controller-local duplicate', () => {
    expect(supportSource).toContain('canAccessTicket,');
    expect(supportSource).toContain('HR_TICKET_CATEGORIES,');
    expect(supportSource).not.toMatch(/async function canAccessTicket\(/);
    expect(supportSource).not.toMatch(/const HR_CATEGORIES\s*=/);
  });
});
