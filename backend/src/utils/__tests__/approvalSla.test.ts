import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { computeSlaDeadline, computeSlaReminderAt, FINANCIAL_SLA_HOURS, MODULE_LABEL } from '../financialApprovals';

// ---------------------------------------------------------------------------
// computeSlaDeadline / computeSlaReminderAt — pure, exercised directly.
// ---------------------------------------------------------------------------
describe('computeSlaDeadline', () => {
  it('is exactly FINANCIAL_SLA_HOURS (24h) after the given instant', () => {
    const from = new Date('2026-09-08T10:00:00.000Z');
    const deadline = computeSlaDeadline(from);
    expect(deadline.getTime() - from.getTime()).toBe(FINANCIAL_SLA_HOURS * 60 * 60 * 1000);
  });
});

describe('computeSlaReminderAt', () => {
  it('fires at 75% of the window — 18h into a 24h deadline (6h before it expires)', () => {
    const deadline = new Date('2026-09-09T10:00:00.000Z'); // 24h after some `from`
    const reminderAt = computeSlaReminderAt(deadline);
    // 24h * (1 - 0.75) = 6h before the deadline.
    expect(deadline.getTime() - reminderAt.getTime()).toBe(6 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Scope guard — Phase 4 (Chat 2) is single-step financial modules ONLY.
// ITSM_TICKET/support_tickets must never gain an SLA deadline through this
// mechanism; this is what actually keeps the sweep from ever touching them
// (approvalSla.ts's FINANCIAL_MODULE_TYPES = Object.keys(MODULE_LABEL)).
// ---------------------------------------------------------------------------
describe('MODULE_LABEL scope (ITSM untouched)', () => {
  it('covers exactly the three single-step financial modules, never ITSM_TICKET', () => {
    const keys = Object.keys(MODULE_LABEL).sort();
    expect(keys).toEqual(['EXPENSE', 'PAYROLL', 'PURCHASE_ORDER']);
    expect(keys).not.toContain('ITSM_TICKET');
  });
});

// ---------------------------------------------------------------------------
// Source-text regression tests for approvalSla.ts — the concurrency/state-
// transition bugs found in the round 2 review (requester exclusion,
// reminder-after-breach, failed-enqueue marking) all require a live
// approval_requests row + eligible-approver rows + email_jobs table to
// exercise end to end, which this sandbox has no DB network path for (see
// backend/docs/SMOKE_*.js for the live-DB integration scripts Abdullah runs
// himself). These assert the FIX is actually present in the shipped source,
// the same "read the real file, grep for the exact pattern" style
// email.test.ts already uses for its 42P08 regression check below.
// ---------------------------------------------------------------------------
describe('approvalSla.ts source regressions (round 2 review fixes)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../approvalSla.ts'), 'utf-8');

  it('excludes the requester from both audience resolutions (reminder AND breach) by employee id', () => {
    // [^)]+ (not *) deliberately excludes this file's own header comment,
    // which mentions "resolveApprovalAudience()" with empty parens in prose
    // — only real calls (which always pass at least company_id/module_type)
    // should be captured here.
    const calls = [...source.matchAll(/resolveApprovalAudience\(([^)]+)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const args of calls) {
      // Must pass row.requester_id as the excludeEmployeeId (4th) argument —
      // a bare 2-arg call (company_id, module_type) would email the
      // requester their own SLA reminder/breach notice.
      expect(args).toContain('row.requester_id');
    }
  });

  it('never sends a reminder once the request has already been marked breached (breach is checked in the reminder branch condition)', () => {
    // The reminder branch is the `else if` after the breach `if` — its own
    // condition must independently guard on sla_breached_at === null, not
    // rely solely on the if/else-if structure (a stale read could still
    // reach it otherwise).
    const reminderBranchMatch = source.match(/else if \(([^)]*sla_reminder_sent_at[^)]*)\)/);
    expect(reminderBranchMatch).not.toBeNull();
    expect(reminderBranchMatch![1]).toContain('row.sla_breached_at === null');
  });

  it('only marks sla_reminder_sent_at after at least one enqueueEmail() call actually succeeded or deduped', () => {
    expect(source).toContain('anySucceeded');
    // The UPDATE must be reachable only past a bail-out for the all-failed case.
    const updateIdx = source.indexOf('SET sla_reminder_sent_at = NOW()');
    const guardIdx = source.indexOf('if (!anySucceeded)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(guardIdx);
  });

  it('marks sla_breached_at unconditionally once the deadline passes (a timestamp of the breach, not a delivery-success flag)', () => {
    const breachUpdateMatch = source.match(/UPDATE approval_requests SET sla_breached_at = NOW\(\) WHERE id = \$1[^`]*`\s*,\s*\[row\.id\]\);/);
    expect(breachUpdateMatch).not.toBeNull();
    // Unlike the reminder branch (which `continue`s past its UPDATE on both
    // the no-audience and all-failed-enqueue cases), the breach branch must
    // fall through to the sla_breached_at UPDATE unconditionally — no
    // `continue` anywhere between the deadline check and `breached++`, so a
    // permanently-unroutable breached request still gets marked terminal
    // instead of being retried forever.
    const breachBlockStart = source.indexOf('if (row.sla_breached_at === null && now >= deadlineMs)');
    const breachBlockEnd = source.indexOf('breached++;');
    expect(breachBlockStart).toBeGreaterThan(-1);
    expect(breachBlockEnd).toBeGreaterThan(breachBlockStart);
    const breachBlock = source.slice(breachBlockStart, breachBlockEnd);
    expect(breachBlock).not.toContain('continue;');
    // The UPDATE itself must appear after the audience.length === 0 branch,
    // not be nested only inside the "had an audience" success path.
    const audienceCheckIdx = breachBlock.indexOf('if (audience.length === 0)');
    const updateIdx = breachBlock.indexOf('SET sla_breached_at = NOW()');
    expect(audienceCheckIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(audienceCheckIdx);
  });

  it('the candidate query stops re-selecting a row once it is breached (terminal state, single-tier model)', () => {
    expect(source).toMatch(/WHERE status = 'pending' AND module_type = ANY\(\$1::text\[\]\) AND sla_deadline_at IS NOT NULL\s*\n\s*AND sla_breached_at IS NULL/);
  });
});
