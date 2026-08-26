import { Request } from 'express';
import { pool } from '../db/pool';

interface AuditParams {
  companyId: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  req: Request;
  // Optional before/after snapshots. Populated by the handful of call sites that log
  // a SENSITIVE_ACTIONS entry (role changes, permission grants, employee/payroll
  // deletion, payroll amounts) — every other call site keeps working unmodified by
  // simply not passing these. Never include password_hash or any other secret in
  // either object; callers are responsible for selecting only safe columns.
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
}

// Actions worth flagging as "sensitive": role/permission changes, deleting a person,
// and anything that touches payroll money. Classified at READ time (not a stored
// column) on purpose — it applies retroactively to every historical row, and adding
// a new sensitive action later is a one-line change here, no migration needed. This
// same set also gates which logAudit() calls get a field-level diff written to
// version_history (MIGRATION_067) — see the diffing logic below.
//
// Source of truth lives here (not in auditLog.controller.ts, which only reads it) so
// this file can use it without an import cycle. Phase 02 (real-time alerts) and
// Phase 04 (compliance reports) are expected to import this same set too rather than
// keeping their own copy — see the Activity Log roadmap.
export const SENSITIVE_ACTIONS = new Set([
  'user_role_changed',
  'user_deleted',
  'user_permissions_updated',
  'job_role_permissions_updated',
  'employee_deleted',
  'payroll_generated',
  'payroll_updated',
  'payroll_deleted',
  'payroll_paid',
]);

export async function logAudit({
  companyId,
  userId,
  action,
  entityType,
  entityId,
  req,
  oldValues,
  newValues,
}: AuditParams): Promise<void> {
  try {
    const result = await pool.query(
      `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        companyId,
        userId || null,
        action,
        entityType,
        entityId || null,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        req.ip,
        req.headers['user-agent'] || null,
      ]
    );

    // Field-level diffs (version_history) are only written for actions already
    // flagged sensitive — Abdullah's locked scope for this sprint, matching the
    // Activity Log roadmap's Phase 01 item exactly (sensitive-only, not every
    // action in the app). Silently skipped when the caller didn't supply anything
    // to diff — true for every logAudit() call site outside the ~9 that were
    // updated for this, so none of them needed to change.
    if (SENSITIVE_ACTIONS.has(action) && (oldValues || newValues)) {
      const auditLogId = result.rows[0].id;
      const diffs = diffFields(oldValues ?? {}, newValues ?? {});
      for (const d of diffs) {
        await pool.query(
          `INSERT INTO version_history (audit_log_id, company_id, field_name, old_value, new_value)
           VALUES ($1, $2, $3, $4, $5)`,
          [auditLogId, companyId, d.field, d.oldValue, d.newValue]
        );
      }
    }
  } catch (err) {
    // an audit-log failure should never fail the request it's logging.
    // console for now, wire to real alerting once this matters in prod.
    console.error('audit log failed:', (err as Error).message);
  }
}

// Shallow field-by-field diff over two plain objects. Values are stringified (JSON
// for objects/arrays, plain text otherwise) since version_history stores everything
// as TEXT — good enough for "what changed" auditing, not meant to be a deep
// structural diff tool. A key missing from newValues (e.g. a delete, where the
// caller passes newValues: null) shows as "had a value, now null" — deliberate: it
// records what existed right before deletion.
function diffFields(
  oldValues: Record<string, unknown>,
  newValues: Record<string, unknown>
): Array<{ field: string; oldValue: string | null; newValue: string | null }> {
  const keys = new Set([...Object.keys(oldValues), ...Object.keys(newValues)]);
  const out: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
  for (const key of keys) {
    const beforeStr = stringifyValue(oldValues[key]);
    const afterStr = stringifyValue(newValues[key]);
    if (beforeStr !== afterStr) {
      out.push({ field: key, oldValue: beforeStr, newValue: afterStr });
    }
  }
  return out;
}

function stringifyValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
