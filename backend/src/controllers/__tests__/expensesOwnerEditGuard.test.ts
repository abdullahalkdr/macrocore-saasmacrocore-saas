import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Phase 4 follow-up — returned Expense requester edit — expenses.controller.ts's update() now also lets the ORIGINAL
// REQUESTER edit their own Expense, but ONLY while its latest approval_requests
// row is 'returned'. This does not widen the existing 'edit_expenses' permission
// key (still admin/manager/individually-granted only) — it's a separate,
// ownership-scoped allowance enforced in the same transaction as the write.
//
// Exercising this against a real concurrent request (two PATCHes racing the same
// row, or a resubmit landing mid-edit) needs a live database this sandbox has no
// network path to (see backend/docs/SMOKE_*.js for the live-DB scripts Abdullah
// runs himself). These assert the fix is actually present in the shipped source,
// the same style every other round-2 regression test in this repo already uses.
// ---------------------------------------------------------------------------
describe('expenses.controller.ts update() — owner-returned-edit authorization (Phase 4 follow-up)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../expenses.controller.ts'), 'utf-8');

  function extractFn(name: string): string {
    const marker = `export const ${name} = asyncHandler(`;
    const start = source.indexOf(marker);
    if (start === -1) throw new Error(`extractFn: ${name} not found in source`);
    // Matching close: walk to the next top-level "export const" after this one,
    // or EOF.
    const nextExport = source.indexOf('\nexport const ', start + marker.length);
    return nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);
  }

  const update = extractFn('update');

  it('locks BOTH the expense row and the latest approval_requests row with FOR UPDATE before deciding anything', () => {
    expect(update).toMatch(/FROM expenses WHERE id = \$1 AND company_id = \$2 FOR UPDATE/);
    expect(update).toMatch(/FROM approval_requests\s*\n\s*WHERE company_id = \$1 AND module_type = 'EXPENSE' AND reference_id = \$2\s*\n\s*ORDER BY created_at DESC LIMIT 1 FOR UPDATE/);
  });

  it('computes privilege the same way it always did (admin/manager OR the edit_expenses permission) — unchanged, not widened', () => {
    expect(update).toContain("['admin', 'manager'].includes(role)");
    expect(update).toContain("hasPermission(userId, 'edit_expenses')");
  });

  it('the owner-returned allowance requires ALL THREE: not already privileged, ownership by created_by, and status === returned', () => {
    const match = update.match(/const isOwnerReturnedEdit = ([^;]+);/);
    expect(match).not.toBeNull();
    const expr = match![1];
    expect(expr).toContain('!isPrivileged');
    expect(expr).toContain('row.created_by === userId');
    expect(expr).toContain("latestApproval?.status === 'returned'");
  });

  it('rejects the request (403) unless privileged OR the owner-returned case applies — no third path in', () => {
    expect(update).toMatch(/if \(!isPrivileged && !isOwnerReturnedEdit\) \{\s*\n\s*throw new AppError\(403,/);
  });

  it('still blocks a privileged editor while the request is genuinely pending (unchanged tampering guard)', () => {
    expect(update).toMatch(/if \(isPrivileged && latestApproval\?\.status === 'pending'\) \{\s*\n\s*throw new AppError\(400,/);
  });

  it('never writes to approval_requests anywhere in this handler — an edit here can never reset the SLA, fire an approver email, or auto-resubmit', () => {
    expect(update).not.toMatch(/UPDATE approval_requests/);
  });

  it('never allows created_by or company_id to be part of the editable field set', () => {
    expect(update).not.toMatch(/sets\.push\(`created_by/);
    expect(update).not.toMatch(/sets\.push\(`company_id/);
  });

  it('logs the audit entry with old/new value snapshots, excluding receipt_image (not diffed into the audit trail)', () => {
    expect(update).toContain("action: 'expense_updated'");
    expect(update).toContain('oldValues,');
    expect(update).toContain('newValues,');
    // receipt_image is still written to the DB (sets.push) but must never be
    // added to newSnapshot (the object that becomes newValues/oldValues).
    const receiptBlock = update.slice(update.indexOf('receipt_image !== undefined'), update.indexOf('location_id !== undefined'));
    expect(receiptBlock).not.toContain('newSnapshot.receipt_image');
  });

  it('rolls back on any failure (ownership check included, since it throws inside the same try block)', () => {
    expect(update).toContain("await client.query('ROLLBACK')");
  });
});

describe('expenses.routes.ts — PATCH no longer role-gated at the route level (auth moved into the controller)', () => {
  const routesSource = fs.readFileSync(path.join(__dirname, '../../routes/expenses.routes.ts'), 'utf-8');

  it("PATCH /:id has no requireRoleOrPermission wrapper — update() does the full check itself now", () => {
    const patchLine = routesSource.split('\n').find((l) => l.includes("router.patch('/:id'"));
    expect(patchLine).toBeDefined();
    expect(patchLine).not.toContain('requireRoleOrPermission');
  });

  it('DELETE /:id is untouched — still admin/manager only (this fix is edit-only, never delete)', () => {
    expect(routesSource).toMatch(/router\.delete\('\/:id',\s*requireRole\('admin', 'manager'\)/);
  });
});
