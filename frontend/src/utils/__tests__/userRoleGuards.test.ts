import { describe, it, expect } from 'vitest';
import { canModifyUserRow, assignableRoleOptions } from '../userRoleGuards';

const ALL_ROLES = ['admin', 'manager', 'employee', 'viewer'] as const;
const MANAGER_INVITABLE = ['employee', 'viewer'] as const;

// Manager privilege-escalation close (production review, 2026-09-09) — the
// frontend half of the fix. These predicates must mirror
// backend/src/controllers/users.controller.ts's update() guard exactly:
// a manager can modify employee/viewer rows only, and can never assign the
// admin/manager role to anyone (even an employee/viewer row).
describe('canModifyUserRow', () => {
  it('lets an admin modify any row, including other admins and managers', () => {
    expect(canModifyUserRow('admin', 'admin')).toBe(true);
    expect(canModifyUserRow('admin', 'manager')).toBe(true);
    expect(canModifyUserRow('admin', 'employee')).toBe(true);
    expect(canModifyUserRow('admin', 'viewer')).toBe(true);
  });

  it('blocks a manager from modifying an existing admin or manager account', () => {
    expect(canModifyUserRow('manager', 'admin')).toBe(false);
    expect(canModifyUserRow('manager', 'manager')).toBe(false);
  });

  it('lets a manager modify employee/viewer rows', () => {
    expect(canModifyUserRow('manager', 'employee')).toBe(true);
    expect(canModifyUserRow('manager', 'viewer')).toBe(true);
  });

  it('a non-admin, non-manager viewer (defensive — this page is admin/manager-only) is treated the same as a manager', () => {
    expect(canModifyUserRow('employee', 'admin')).toBe(false);
    expect(canModifyUserRow('employee', 'employee')).toBe(true);
  });
});

describe('assignableRoleOptions', () => {
  it('gives an admin the full role list for any row', () => {
    expect(assignableRoleOptions('admin', 'employee', [...ALL_ROLES], [...MANAGER_INVITABLE])).toEqual(ALL_ROLES);
    expect(assignableRoleOptions('admin', 'admin', [...ALL_ROLES], [...MANAGER_INVITABLE])).toEqual(ALL_ROLES);
  });

  it('gives a manager only employee/viewer as choices on a row they CAN modify — never admin/manager, even for an employee row', () => {
    const options = assignableRoleOptions('manager', 'employee', [...ALL_ROLES], [...MANAGER_INVITABLE]);
    expect(options).toEqual(MANAGER_INVITABLE);
    expect(options).not.toContain('admin');
    expect(options).not.toContain('manager');
  });

  it('falls back to the full role list on a row a manager can’t modify — so the (disabled) select still shows the real current role instead of rendering blank', () => {
    const options = assignableRoleOptions('manager', 'admin', [...ALL_ROLES], [...MANAGER_INVITABLE]);
    expect(options).toEqual(ALL_ROLES);
    expect(options).toContain('admin');
  });
});
