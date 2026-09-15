import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildBillingAuditSnapshot } from '../admin.controller';

describe('buildBillingAuditSnapshot()', () => {
  it('returns exactly the three safe billing fields before and after', () => {
    const snapshots = buildBillingAuditSnapshot({
      previous_plan: 'trial', previous_subscription_status: 'trial', previous_trial_end_date: '2026-09-01',
      plan: 'gold', subscription_status: 'active', trial_end_date: null,
    });
    expect(snapshots).toEqual({
      oldValues: { plan: 'trial', subscription_status: 'trial', trial_end_date: '2026-09-01' },
      newValues: { plan: 'gold', subscription_status: 'active', trial_end_date: null },
    });
  });

  it('preserves a no-op as identical full snapshots', () => {
    const snapshots = buildBillingAuditSnapshot({
      previous_plan: 'gold', previous_subscription_status: 'active', previous_trial_end_date: null,
      plan: 'gold', subscription_status: 'active', trial_end_date: null,
    });
    expect(snapshots.oldValues).toEqual(snapshots.newValues);
  });
});

describe('updateCompany() source-level invariants', () => {
  const source = fs.readFileSync(path.join(__dirname, '../admin.controller.ts'), 'utf-8');
  const start = source.indexOf("export const updateCompany = asyncHandler(");
  const end = source.indexOf('\nexport const listSubscriptions', start);
  const updateCompany = source.slice(start, end);

  it('uses one checked-out transaction and checks managed state only after taking the company lock', () => {
    expect(updateCompany).toContain('const client = await pool.connect()');
    const begin = updateCompany.indexOf("client.query('BEGIN')");
    const lock = updateCompany.indexOf('FROM companies WHERE id = $1 FOR UPDATE');
    const managed = updateCompany.indexOf('SELECT EXISTS');
    const update = updateCompany.indexOf('UPDATE companies SET');
    const commit = updateCompany.indexOf("client.query('COMMIT')");
    expect(begin).toBeLessThan(lock);
    expect(lock).toBeLessThan(managed);
    expect(managed).toBeLessThan(update);
    expect(update).toBeLessThan(commit);
    expect(updateCompany).toContain("client.query('ROLLBACK').catch(() => {})");
    expect(updateCompany).toContain('client.release()');
  });

  it('keeps B1 audit data narrow and both B1/B2 actions outside SENSITIVE_ACTIONS', () => {
    expect(updateCompany).toContain("action: 'admin_company_billing_updated'");
    expect(updateCompany).toContain("entityType: 'companies'");
    expect(updateCompany).toContain('userId: null');
    const auditSource = fs.readFileSync(path.join(__dirname, '../../utils/audit.ts'), 'utf-8');
    const setBody = auditSource.match(/export const SENSITIVE_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
    expect(setBody).not.toContain('admin_company_billing_updated');
    expect(setBody).not.toContain('admin_subscription_activated');
  });
});
