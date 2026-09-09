import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resolveRejectReason, REJECT_REASON_MAX_LENGTH } from '../financialApprovals';
import { AppError } from '../../middleware/errorHandler';

// ---------------------------------------------------------------------------
// Source-text regression tests for financialApprovals.ts — resolveApprovalAudience()'s
// dedup/exclusion logic and fileApprovalRequest()'s post-commit notify() pattern
// both require a live company/users/employees table set to exercise for real
// (this sandbox has no DB network path — see backend/docs/SMOKE_*.js for the
// live-DB scripts Abdullah runs himself). These assert the fix is actually
// present in the shipped source, mirroring email.ts's own source-regression
// test style.
// ---------------------------------------------------------------------------
describe('financialApprovals.ts source regressions (round 2 review fixes)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../financialApprovals.ts'), 'utf-8');

  it('resolveApprovalAudience excludes by BOTH user id and employee id (two identifiers, since call sites hold different ones)', () => {
    const sigMatch = source.match(/export async function resolveApprovalAudience\(([^)]*)\)/s);
    expect(sigMatch).not.toBeNull();
    expect(sigMatch![1]).toContain('excludeUserId');
    expect(sigMatch![1]).toContain('excludeEmployeeId');
  });

  it('resolveApprovalAudience only includes users with a linked employee record (employee_id IS NOT NULL)', () => {
    // Both queries inside it (managers, permission holders) must carry this.
    const occurrences = (source.match(/employee_id IS NOT NULL/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('resolveApprovalAudience dedupes by BOTH user id and normalized (trimmed, lowercased) email', () => {
    expect(source).toContain('byUserId.has(row.id)');
    expect(source).toMatch(/row\.email\.trim\(\)\.toLowerCase\(\)/);
    expect(source).toContain('seenEmails.has(normalizedEmail)');
  });

  it('notifyEligibleApprovers excludes the requester from the email audience by employee id', () => {
    const fnMatch = source.match(/export async function notifyEligibleApprovers\([\s\S]*?\n\}\n/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).toContain('resolveApprovalAudience(companyId, moduleType, excludeUserId, requesterEmployeeId)');
  });

  it('fileApprovalRequest() never fires notifications directly — only via the returned notify() closure, called by the caller after their own commit', () => {
    const fnMatch = source.match(/export async function fileApprovalRequest\([\s\S]*?\n\}\n/);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![0];
    // notifyEligibleApprovers/notifyRequesterSubmitted must appear ONLY inside
    // the `const notify = (): void => { ... }` closure body, never awaited
    // directly in the function's own top-level flow (which would fire before
    // a transactional caller's COMMIT/ROLLBACK is known).
    const notifyClosureStart = body.indexOf('const notify = (): void => {');
    expect(notifyClosureStart).toBeGreaterThan(-1);
    const beforeClosure = body.slice(0, notifyClosureStart);
    expect(beforeClosure).not.toContain('notifyEligibleApprovers(');
    expect(beforeClosure).not.toContain('notifyRequesterSubmitted(');
    const afterClosureOpen = body.slice(notifyClosureStart);
    expect(afterClosureOpen).toContain('notifyEligibleApprovers(');
    expect(afterClosureOpen).toContain('notifyRequesterSubmitted(');
    // The function returns the closure itself, not its result — the caller
    // decides when (or whether) to invoke it.
    expect(body).toContain('return { ...request, notify };');
  });

  it('fileApprovalRequest() accepts an optional client so a transactional caller can join its own transaction', () => {
    const sigMatch = source.match(/export async function fileApprovalRequest\(([^)]*)\)\s*:/s);
    expect(sigMatch).not.toBeNull();
    expect(sigMatch![1]).toContain('client?: PoolClient');
  });
});

// ---------------------------------------------------------------------------
// Phase 4 follow-up — resolveRejectReason(). Unlike the rest of this file
// (which needs a live company/users/approval_requests table set and so stays
// as source-text regression checks above), this is a plain pure function with
// no DB/request/response involved — extracted specifically so its actual
// 400-vs-success behavior can be exercised for real, not just grepped for in
// the shipped source. approvals.controller.ts's actionRequest() is the only
// caller; these are the same four behaviors it depends on.
// ---------------------------------------------------------------------------
describe('resolveRejectReason() — mandatory rejection reason for financial modules', () => {
  it('throws AppError(400) when EXPENSE/PAYROLL/PURCHASE_ORDER rejection has no reason at all', () => {
    for (const moduleType of ['EXPENSE', 'PAYROLL', 'PURCHASE_ORDER']) {
      let caught: unknown;
      try {
        resolveRejectReason(moduleType, undefined);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).statusCode).toBe(400);
    }
  });

  it('throws AppError(400) when the reason is whitespace-only', () => {
    let caught: unknown;
    try {
      resolveRejectReason('EXPENSE', '    \n\t  ');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(400);
  });

  it('throws AppError(400) when the reason exceeds REJECT_REASON_MAX_LENGTH', () => {
    const tooLong = 'a'.repeat(REJECT_REASON_MAX_LENGTH + 1);
    let caught: unknown;
    try {
      resolveRejectReason('PAYROLL', tooLong);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(400);
  });

  it('succeeds and returns the TRIMMED reason for a valid financial rejection', () => {
    expect(resolveRejectReason('EXPENSE', '  Missing receipt, please resubmit.  ')).toBe('Missing receipt, please resubmit.');
    expect(resolveRejectReason('PAYROLL', 'Amount does not match contract')).toBe('Amount does not match contract');
    expect(resolveRejectReason('PURCHASE_ORDER', 'Wrong supplier')).toBe('Wrong supplier');
  });

  it('accepts a reason exactly at REJECT_REASON_MAX_LENGTH (boundary, not off-by-one)', () => {
    const exact = 'a'.repeat(REJECT_REASON_MAX_LENGTH);
    expect(resolveRejectReason('EXPENSE', exact)).toBe(exact);
  });

  it('ITSM_TICKET rejection is completely unaffected — no reason required, none returned, never throws', () => {
    expect(resolveRejectReason('ITSM_TICKET', undefined)).toBeNull();
    expect(resolveRejectReason('ITSM_TICKET', '')).toBeNull();
    expect(resolveRejectReason('ITSM_TICKET', 'some reason anyway')).toBeNull();
  });

  it('an unknown/future module_type is also left alone (explicit allowlist, not a negative check)', () => {
    expect(resolveRejectReason('SOME_FUTURE_MODULE', undefined)).toBeNull();
  });
});
