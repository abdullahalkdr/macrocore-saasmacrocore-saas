import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Source-text regression tests (round 2 review, point 4) — fileApprovalRequest()
// must never fire notifications before its caller's own business transaction
// actually commits. payroll.controller.ts's pay() and purchaseOrders.controller.ts's
// update() have no surrounding transaction of their own (the INSERT inside
// fileApprovalRequest() commits via the shared pool immediately), so calling
// .notify() right after the await is safe there. expenses.controller.ts's
// create() DOES wrap fileApprovalRequest() in its own transaction (the
// expense INSERT + the approval_requests INSERT must commit or roll back
// together — see that file's own "orphaned pending_approval" bugfix comment),
// so .notify() there must be deferred until strictly after COMMIT.
//
// Exercising the actual rollback (an EXPENSE create() that throws after
// fileApprovalRequest() succeeds, verifying zero email_jobs/notifications
// rows exist) requires a live database — this sandbox has no DB network path
// (see backend/docs/SMOKE_*.js for the live-DB scripts Abdullah runs
// himself). These assert the shape of the fix is actually in the shipped
// source.
// ---------------------------------------------------------------------------
describe('post-commit notify() call sites (round 2 review, point 4)', () => {
  it('payroll.controller.ts calls filed.notify() right after fileApprovalRequest() (no surrounding transaction to wait on)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../payroll.controller.ts'), 'utf-8');
    expect(source).toMatch(
      /const filed = await fileApprovalRequest\(companyId, 'PAYROLL', id as string, req\.auth!\.userId\);\s*\n\s*filed\.notify\(\);/
    );
  });

  it("purchaseOrders.controller.ts calls filed.notify() right after fileApprovalRequest() (no surrounding transaction to wait on)", () => {
    const source = fs.readFileSync(path.join(__dirname, '../purchaseOrders.controller.ts'), 'utf-8');
    expect(source).toMatch(
      /const filed = await fileApprovalRequest\(companyId, 'PURCHASE_ORDER', id as string, req\.auth!\.userId\);\s*\n\s*filed\.notify\(\);/
    );
  });

  describe('expenses.controller.ts create() — the critical transactional case', () => {
    const source = fs.readFileSync(path.join(__dirname, '../expenses.controller.ts'), 'utf-8');
    const fnMatch = source.match(/export const create = asyncHandler\([\s\S]*?\n\}\);\n/);
    if (!fnMatch) throw new Error('could not locate create() in expenses.controller.ts');
    const body = fnMatch[0];

    it('captures `filed` from inside the try/BEGIN block, not outside it', () => {
      const beginIdx = body.indexOf("await client.query('BEGIN')");
      const filedAssignIdx = body.indexOf('filed = await fileApprovalRequest(');
      expect(beginIdx).toBeGreaterThan(-1);
      expect(filedAssignIdx).toBeGreaterThan(beginIdx);
    });

    it('calls COMMIT after the fileApprovalRequest() call, still inside the same try block', () => {
      const filedAssignIdx = body.indexOf('filed = await fileApprovalRequest(');
      const commitIdx = body.indexOf("await client.query('COMMIT')");
      expect(commitIdx).toBeGreaterThan(filedAssignIdx);
    });

    it('calls filed?.notify() strictly AFTER the try/catch/finally block (after client.release()), never inside it', () => {
      const finallyReleaseIdx = body.lastIndexOf('client.release();');
      const notifyIdx = body.indexOf('filed?.notify();');
      expect(finallyReleaseIdx).toBeGreaterThan(-1);
      expect(notifyIdx).toBeGreaterThan(finallyReleaseIdx);
    });

    it('rolls back on any failure before notify() could ever be reached', () => {
      expect(body).toContain("await client.query('ROLLBACK')");
    });
  });

  it('fileApprovalRequest() itself never fires notifications synchronously — enforced separately in financialApprovals.test.ts', () => {
    // Cross-reference only — the authoritative check lives in
    // financialApprovals.test.ts ("fileApprovalRequest() never fires
    // notifications directly"). Kept here as a signpost so a reader of this
    // file knows where the other half of the guarantee is verified.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Source-text regression test (round 2 review, point 6) — ONE scheduler
// trigger drives both the email queue sweep and the approval SLA sweep, with
// isolated failure handling per task, not two independent setInterval timers.
// ---------------------------------------------------------------------------
describe('index.ts scheduler (round 2 review, point 6)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../index.ts'), 'utf-8');

  it('registers exactly one setInterval for the background sweeps', () => {
    const matches = source.match(/setInterval\(/g) || [];
    expect(matches.length).toBe(1);
  });

  it('the single interval task calls both sweepEmailQueue() and sweepApprovalSla(), each with its own isolated catch', () => {
    const runSweepsMatch = source.match(/const runSweeps = \(\): void => \{[\s\S]*?\};/);
    expect(runSweepsMatch).not.toBeNull();
    const body = runSweepsMatch![0];
    expect(body).toContain('sweepEmailQueue()');
    expect(body).toContain('sweepApprovalSla()');
    // Each call has its own .catch(...) -- a failure in one must never abort
    // or delay the other.
    const emailCallMatch = body.match(/sweepEmailQueue\(\)\.catch\(/);
    const slaCallMatch = body.match(/sweepApprovalSla\(\)\.catch\(/);
    expect(emailCallMatch).not.toBeNull();
    expect(slaCallMatch).not.toBeNull();
  });

  it('runs the sweeps once immediately (startup) in addition to the interval', () => {
    expect(source).toContain('runSweeps(); // once right away');
  });
});
