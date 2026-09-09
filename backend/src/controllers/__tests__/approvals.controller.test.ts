import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Source-text regression tests for approvals.controller.ts's actionRequest() —
// the round 2 review's atomicity/concurrency fixes (point 3) require two
// concurrent requests racing against the same live approval_requests row to
// exercise end to end, which this sandbox has no DB network path for (see
// backend/docs/SMOKE_*.js for the live-DB integration scripts Abdullah runs
// himself). These assert the fix is actually present in the shipped source.
// ---------------------------------------------------------------------------
describe('approvals.controller.ts source regressions (round 2 review, point 3)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../approvals.controller.ts'), 'utf-8');

  function extractBranch(startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    if (start === -1) throw new Error(`extractBranch: start marker not found in source:\n${startMarker}`);
    const end = source.indexOf(endMarker, start);
    if (end === -1 || end <= start) throw new Error(`extractBranch: end marker not found after start in source:\n${endMarker}`);
    return source.slice(start, end);
  }

  describe('resubmit branch — atomic, row-locked, post-commit notify', () => {
    const branch = extractBranch("if (action === 'resubmitted') {", "// approved / rejected / returned all require");

    it('locks the row with FOR UPDATE before touching it', () => {
      expect(branch).toMatch(/SELECT \* FROM approval_requests WHERE id = \$1 AND company_id = \$2 FOR UPDATE/);
    });

    it('re-validates status and requester identity AFTER acquiring the lock, not against the pre-lock read', () => {
      expect(branch).toContain("lockedRequest.status !== 'returned'");
      expect(branch).toContain('myId !== lockedRequest.requester_id');
    });

    it('bundles the log insert + status/step change + SLA reset in ONE transaction (all via `client`, not the shared pool)', () => {
      const beginIdx = branch.indexOf("await client.query('BEGIN')");
      const commitIdx = branch.indexOf("await client.query('COMMIT')");
      expect(beginIdx).toBeGreaterThan(-1);
      expect(commitIdx).toBeGreaterThan(beginIdx);
      const txnBody = branch.slice(beginIdx, commitIdx);
      expect(txnBody).toContain('approval_steps_log');
      expect(txnBody).toContain("SET current_step = 1, status = 'pending'");
      expect(txnBody).toContain('sla_deadline_at = $1, sla_reminder_sent_at = NULL, sla_breached_at = NULL');
      // None of these three writes may go through the unguarded shared pool
      // inside this branch — every write here must be `client.query`.
      expect(txnBody).not.toMatch(/\bpool\.query/);
    });

    it('fires notifications ONLY after COMMIT (post-commit, never inside the try block)', () => {
      const commitIdx = branch.indexOf("await client.query('COMMIT')");
      const releaseIdx = branch.indexOf('client.release();', commitIdx);
      const afterTxn = branch.slice(releaseIdx);
      expect(afterTxn).toContain('notifyItsmStepPending(');
      expect(afterTxn).toContain('notifyEligibleApprovers(');
      // And NOT inside the try block (before COMMIT).
      const beforeCommit = branch.slice(0, commitIdx);
      expect(beforeCommit).not.toContain('notifyItsmStepPending(');
      expect(beforeCommit).not.toContain('notifyEligibleApprovers(');
    });

    it('rolls back on any failure', () => {
      expect(branch).toContain("await client.query('ROLLBACK')");
    });
  });

  describe('single-step (financial) approve/reject/returned branch — row-locked, concurrency-guarded', () => {
    const branch = extractBranch(
      '// Single-step modules — approve/reject resolve the request immediately,',
      "if (action === 'returned') {\n    notifyMakerReturned"
    );

    it('locks the row with FOR UPDATE before writing the decision', () => {
      expect(branch).toMatch(/SELECT \* FROM approval_requests WHERE id = \$1 AND company_id = \$2 FOR UPDATE/);
    });

    it("re-validates status === 'pending' AFTER acquiring the lock — this is what stops two simultaneous reviewers from both succeeding", () => {
      expect(branch).toContain("lockedRequest.status !== 'pending'");
    });

    it('uses the locked row (not the pre-lock snapshot) for the log insert and the EXPENSE side-effect update', () => {
      expect(branch).toContain('lockedRequest.current_step');
      expect(branch).toContain('lockedRequest.module_type');
      expect(branch).toContain('lockedRequest.reference_id');
    });

    it('fires notifyMakerResolved ONLY after COMMIT (post-commit, never inside the try block)', () => {
      // The actual call form, not the bare function name — this branch's own
      // explanatory comment mentions "notifyMakerResolved()" in prose before
      // the transaction even starts, which a bare-name substring check would
      // wrongly flag as an early call.
      const actualCall = 'notifyMakerResolved(companyId, lockedRequest,';
      const commitIdx = branch.indexOf("await client.query('COMMIT')");
      expect(commitIdx).toBeGreaterThan(-1);
      const releaseIdx = branch.indexOf('client.release();', commitIdx);
      const afterTxn = branch.slice(releaseIdx);
      expect(afterTxn).toContain(actualCall);
      const beforeCommit = branch.slice(0, commitIdx);
      expect(beforeCommit).not.toContain(actualCall);
    });

    it('rolls back on any failure', () => {
      expect(branch).toContain("await client.query('ROLLBACK')");
    });
  });

  describe('ITSM_TICKET branch — untouched (out of Phase 4 / Chat 2 scope)', () => {
    const branch = extractBranch(
      "if (request.module_type === 'ITSM_TICKET') {\n    const steps = await getWorkflowSteps",
      '} else {\n    // Single-step modules'
    );

    it('was not given the new row-lock treatment — still the original unlocked BEGIN/COMMIT shape', () => {
      expect(branch).not.toContain('FOR UPDATE');
      expect(branch).not.toContain('lockedRequest');
    });

    it('still reads/writes via the plain `request` object exactly as before', () => {
      expect(branch).toContain('request.current_step');
      expect(branch).toContain('request.reference_id');
    });
  });

  it('the shared "returned" notification call uses the locked/revalidated row for the financial branch, and the original row for ITSM (untouched)', () => {
    expect(source).toContain('let noteRequest: any = request;');
    expect(source).toContain('noteRequest = lockedRequest;');
    expect(source).toContain('notifyMakerReturned(companyId, noteRequest, String(comments))');
  });
});
