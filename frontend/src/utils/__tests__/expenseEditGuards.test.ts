import { describe, it, expect } from 'vitest';
import { canOwnerEditReturnedExpense } from '../expenseEditGuards';

// Phase 4 follow-up — returned Expense requester edit — the requester's own-returned-expense edit affordance
// (ExpensesPage.tsx). This is a UX mirror of the real, server-side gate
// (expenses.controller.ts's update()) — see backend/src/controllers/__tests__
// /expensesOwnerEditGuard.test.ts for the backend-side regression check.
describe('canOwnerEditReturnedExpense', () => {
  it('allows the creator to edit their own expense while it is returned', () => {
    expect(
      canOwnerEditReturnedExpense({ approvalStatus: 'returned', createdBy: 'user-1', viewerId: 'user-1', viewerIsManager: false })
    ).toBe(true);
  });

  it('blocks a plain employee from editing someone else\'s returned expense', () => {
    expect(
      canOwnerEditReturnedExpense({ approvalStatus: 'returned', createdBy: 'user-1', viewerId: 'user-2', viewerIsManager: false })
    ).toBe(false);
  });

  it('blocks the creator once the request is no longer returned (pending/approved/rejected/null)', () => {
    for (const status of ['pending', 'approved', 'rejected', null, undefined] as const) {
      expect(
        canOwnerEditReturnedExpense({ approvalStatus: status, createdBy: 'user-1', viewerId: 'user-1', viewerIsManager: false })
      ).toBe(false);
    }
  });

  it('never applies to admin/manager viewers — they use the existing isManager path instead, not this one', () => {
    expect(
      canOwnerEditReturnedExpense({ approvalStatus: 'returned', createdBy: 'user-1', viewerId: 'user-1', viewerIsManager: true })
    ).toBe(false);
  });

  it('is false with no signed-in viewer id (defensive)', () => {
    expect(
      canOwnerEditReturnedExpense({ approvalStatus: 'returned', createdBy: 'user-1', viewerId: undefined, viewerIsManager: false })
    ).toBe(false);
    expect(
      canOwnerEditReturnedExpense({ approvalStatus: 'returned', createdBy: 'user-1', viewerId: null, viewerIsManager: false })
    ).toBe(false);
  });
});
