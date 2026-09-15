import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildBillingAuditSnapshot } from '../admin.controller';

// ---------------------------------------------------------------------------
// Chat 4A / Stage B1 — admin.controller.ts's updateCompany() now also writes a
// best-effort audit_logs entry ('admin_company_billing_updated') alongside the
// existing companies UPDATE, using a single atomic CTE statement (FOR UPDATE +
// UPDATE ... FROM ... RETURNING) so the before/after values it logs are correct
// even under a concurrent PATCH to the same company.
//
// This is deliberately scoped narrow: logAudit() is a best-effort side channel
// (own pool.query, own try/catch, never throws — see utils/audit.ts), not a
// guaranteed lifecycle engine or a recovery source for future billing
// notifications, and 'admin_company_billing_updated' is NOT added to
// SENSITIVE_ACTIONS — no field-diff row, no WhatsApp alert, nothing beyond a
// plain audit_logs row with old_values/new_values populated.
//
// buildBillingAuditSnapshot() is pure (no DB, no I/O) and gets real unit tests
// below — not just a "was it called" mock check. The SQL shape and the
// logAudit() call site itself can't be exercised against a real Postgres in
// this sandbox (no live DB reachable here — see backend/vitest.config.ts), so
// those are verified by source inspection, following the same convention as
// backend/src/controllers/__tests__/expensesOwnerEditGuard.test.ts.
// ---------------------------------------------------------------------------

describe('buildBillingAuditSnapshot() — pure before/after snapshot builder', () => {
  it('splits a single RETURNING row into full oldValues/newValues snapshots', () => {
    const { oldValues, newValues } = buildBillingAuditSnapshot({
      previous_plan: 'trial',
      previous_subscription_status: 'trial',
      previous_trial_end_date: '2026-09-01T00:00:00.000Z',
      plan: 'gold',
      subscription_status: 'active',
      trial_end_date: null,
    });

    expect(oldValues).toEqual({
      plan: 'trial',
      subscription_status: 'trial',
      trial_end_date: '2026-09-01T00:00:00.000Z',
    });
    expect(newValues).toEqual({
      plan: 'gold',
      subscription_status: 'active',
      trial_end_date: null,
    });
  });

  it('always returns all three billing fields, even when the PATCH only targeted one of them', () => {
    // A PATCH that only sent { subscription_status } still updates only that
    // column server-side, so plan/trial_end_date come back unchanged (equal in
    // both previous_* and current) — buildBillingAuditSnapshot must still emit
    // full snapshots, not just the field that changed.
    const { oldValues, newValues } = buildBillingAuditSnapshot({
      previous_plan: 'bronze',
      previous_subscription_status: 'past_due',
      previous_trial_end_date: null,
      plan: 'bronze',
      subscription_status: 'suspended',
      trial_end_date: null,
    });

    expect(oldValues).toEqual({ plan: 'bronze', subscription_status: 'past_due', trial_end_date: null });
    expect(newValues).toEqual({ plan: 'bronze', subscription_status: 'suspended', trial_end_date: null });
  });

  it('reflects a genuine no-op (previous and current identical) rather than hiding it', () => {
    const { oldValues, newValues } = buildBillingAuditSnapshot({
      previous_plan: 'gold',
      previous_subscription_status: 'active',
      previous_trial_end_date: null,
      plan: 'gold',
      subscription_status: 'active',
      trial_end_date: null,
    });

    expect(oldValues).toEqual(newValues);
  });

  it('never fabricates or drops a field — output keys are exactly plan/subscription_status/trial_end_date', () => {
    const { oldValues, newValues } = buildBillingAuditSnapshot({
      previous_plan: 'silver',
      previous_subscription_status: 'active',
      previous_trial_end_date: '2026-12-31',
      plan: 'silver',
      subscription_status: 'cancelled',
      trial_end_date: '2026-12-31',
    });

    expect(Object.keys(oldValues).sort()).toEqual(['plan', 'subscription_status', 'trial_end_date']);
    expect(Object.keys(newValues).sort()).toEqual(['plan', 'subscription_status', 'trial_end_date']);
  });
});

describe('admin.controller.ts updateCompany() — SQL shape and audit call site (source inspection)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../admin.controller.ts'), 'utf-8');

  function extractFn(name: string): string {
    const marker = `export const ${name} = asyncHandler(`;
    const start = source.indexOf(marker);
    if (start === -1) throw new Error(`extractFn: ${name} not found in source`);
    const nextExport = source.indexOf('\nexport const ', start + marker.length);
    return nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);
  }

  const updateCompany = extractFn('updateCompany');

  it('locks the row with FOR UPDATE inside a CTE, then updates+reads previous/current values in one statement (no separate BEGIN/COMMIT)', () => {
    expect(updateCompany).toMatch(/WITH previous AS \(/);
    expect(updateCompany).toMatch(/FROM companies\s*\n\s*WHERE id = \$\$\{i\}\s*\n\s*FOR UPDATE/);
    expect(updateCompany).toMatch(/UPDATE companies\s*\n\s*SET \$\{sets\.join\(', '\)\}\s*\n\s*FROM previous\s*\n\s*WHERE companies\.id = previous\.id/);
    expect(updateCompany).not.toContain("pool.query('BEGIN')");
    expect(updateCompany).not.toContain('client.query');
  });

  it('RETURNING carries both the previous_* and the current values back on the same row', () => {
    expect(updateCompany).toContain('previous.plan AS previous_plan');
    expect(updateCompany).toContain('previous.subscription_status AS previous_subscription_status');
    expect(updateCompany).toContain('previous.trial_end_date AS previous_trial_end_date');
  });

  it('still 404s the same way when the company does not exist', () => {
    expect(updateCompany).toMatch(/if \(!row\) throw new AppError\(404, 'Company not found'\);/);
  });

  it('calls logAudit() unconditionally after a successful update — not gated on anything actually differing', () => {
    // "unconditionally" here means: no `if (...)` guard sits between the 404 check
    // and the logAudit call — every successful PATCH (no-op included) gets logged.
    const between404AndAwait = updateCompany.slice(
      updateCompany.indexOf("throw new AppError(404, 'Company not found');"),
      updateCompany.indexOf('await logAudit(')
    );
    expect(between404AndAwait).not.toMatch(/if\s*\(/);
    expect(updateCompany).toContain('await logAudit({');
  });

  it("uses the new, non-sensitive 'admin_company_billing_updated' action and companies as the entity type", () => {
    expect(updateCompany).toContain("action: 'admin_company_billing_updated'");
    expect(updateCompany).toContain("entityType: 'companies'");
  });

  it('never attaches a per-user actor — requireAdminKey has no per-user identity to give it', () => {
    expect(updateCompany).toContain('userId: null');
    expect(updateCompany).not.toContain('req.auth');
  });

  it('passes only plan/subscription_status/trial_end_date as old/new values — never the admin key, headers, or any other request data', () => {
    const logAuditCallStart = updateCompany.indexOf('await logAudit({');
    const logAuditCallEnd = updateCompany.indexOf('});', logAuditCallStart);
    const call = updateCompany.slice(logAuditCallStart, logAuditCallEnd);
    expect(call).toContain('oldValues,');
    expect(call).toContain('newValues,');
    expect(call).not.toMatch(/x-admin-key/i);
    expect(call).not.toMatch(/ADMIN_API_KEY/);
    expect(call).not.toMatch(/req\.headers/);
    expect(call).not.toMatch(/req\.body/);
  });

  it('a logAudit failure cannot roll back the UPDATE or change the response outcome — the UPDATE already ran and its result was already read before logAudit is ever called (note: the request still awaits logAudit settling, success or caught failure, before responding — see real-failure behavior in adminUpdateCompanyAuditFailureIsolation.test.ts)', () => {
    // The UPDATE happens (and its result is read) strictly before logAudit is ever
    // called — so by the time logAudit runs, the billing change has already been
    // decided; logAudit() itself (utils/audit.ts) is the thing responsible for
    // never throwing. This is source-inspection only — the actual runtime proof
    // that a real logAudit() failure doesn't change the response is in
    // adminUpdateCompanyAuditFailureIsolation.test.ts.
    const updateIndex = updateCompany.indexOf('const result = await pool.query(');
    const logAuditIndex = updateCompany.indexOf('await logAudit(');
    expect(updateIndex).toBeGreaterThan(-1);
    expect(logAuditIndex).toBeGreaterThan(updateIndex);
  });
});

describe("utils/audit.ts SENSITIVE_ACTIONS — 'admin_company_billing_updated' is deliberately excluded", () => {
  const auditSource = fs.readFileSync(path.join(__dirname, '../../utils/audit.ts'), 'utf-8');

  it('does not add the new action to SENSITIVE_ACTIONS (no field-diff row, no WhatsApp alert for this stage)', () => {
    const match = auditSource.match(/export const SENSITIVE_ACTIONS = new Set\(\[([\s\S]*?)\]\);/);
    expect(match).not.toBeNull();
    const setBody = match![1];
    expect(setBody).not.toContain('admin_company_billing_updated');
  });
});
