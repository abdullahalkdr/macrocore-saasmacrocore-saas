// Phase 4 follow-up — returned Expense requester edit — UI-side mirror of expenses.controller.ts's update()
// authorization: the ORIGINAL REQUESTER of their own Expense may see an Edit
// affordance for it, but ONLY while its latest approval_requests row is
// 'returned'. This is deliberately just a UX predicate, never the real gate —
// the backend independently re-checks ownership + status under a row lock on
// every PATCH, so this file being wrong in either direction (shown too
// early/late) can never grant or block an actual edit by itself. Extracted out
// of ExpensesPage.tsx (same pattern as userRoleGuards.ts) so it's a plain,
// directly testable function instead of logic buried inside a component.
export interface ExpenseEditGuardInput {
  approvalStatus: 'pending' | 'approved' | 'rejected' | 'returned' | null | undefined;
  createdBy: string;
  viewerId: string | undefined | null;
  viewerIsManager: boolean;
}

export function canOwnerEditReturnedExpense(input: ExpenseEditGuardInput): boolean {
  return !input.viewerIsManager && input.approvalStatus === 'returned' && !!input.viewerId && input.createdBy === input.viewerId;
}
