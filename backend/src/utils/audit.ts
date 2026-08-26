import { Request } from 'express';
import { pool } from '../db/pool';
import { sendWhatsAppAlert, buildSensitiveActionMessage } from './whatsapp';

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
// audit_log_field_changes (MIGRATION_067) — see the diffing logic below.
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

    // Field-level diffs (audit_log_field_changes — named to avoid colliding with
    // this schema's pre-existing, unrelated version_history table) are only written
    // for actions already flagged sensitive — Abdullah's locked scope for this
    // sprint, matching the Activity Log roadmap's Phase 01 item exactly
    // (sensitive-only, not every action in the app). Silently skipped when the
    // caller didn't supply anything to diff — true for every logAudit() call site
    // outside the ~9 that were updated for this, so none of them needed to change.
    if (SENSITIVE_ACTIONS.has(action) && (oldValues || newValues)) {
      const auditLogId = result.rows[0].id;
      const diffs = diffFields(oldValues ?? {}, newValues ?? {});
      for (const d of diffs) {
        await pool.query(
          `INSERT INTO audit_log_field_changes (audit_log_id, company_id, field_name, old_value, new_value)
           VALUES ($1, $2, $3, $4, $5)`,
          [auditLogId, companyId, d.field, d.oldValue, d.newValue]
        );
      }

      // Phase 02 of the Activity Log roadmap — real-time WhatsApp alert for every
      // sensitive action (Abdullah's locked scope: ALL of SENSITIVE_ACTIONS, one
      // fixed number per company — see MIGRATION_068 and utils/whatsapp.ts).
      // sendWhatsAppAlert() is a safe no-op until Abdullah's Meta Business
      // Platform credentials exist as env vars; never throws, never delays or
      // fails the request — the audit write above already succeeded regardless.
      const [target, actor] = await Promise.all([
        resolveTarget(companyId, { entity_type: entityType, entity_id: entityId ?? null, old_values: oldValues ?? null, new_values: newValues ?? null }),
        userId ? getActorLabel(companyId, userId) : Promise.resolve(null),
      ]);
      await sendWhatsAppAlert(companyId, buildSensitiveActionMessage({ action, actorLabel: actor, target, diffs }));
    }
  } catch (err) {
    // an audit-log failure should never fail the request it's logging.
    // console for now, wire to real alerting once this matters in prod.
    console.error('audit log failed:', (err as Error).message);
  }
}

// Shallow field-by-field diff over two plain objects. Values are stringified (JSON
// for objects/arrays, plain text otherwise) since audit_log_field_changes stores
// everything as TEXT — good enough for "what changed" auditing, not meant to be a
// deep structural diff tool. A key missing from newValues (e.g. a delete, where the
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

// Best-effort "who/what was this change applied to" label — shared by the
// real-time WhatsApp alert above and GET /audit-log/:id/changes
// (auditLog.controller.ts, which imports this instead of keeping its own copy).
// Every entity_type used by a SENSITIVE_ACTIONS call site is handled explicitly;
// anything else falls through to { type: entity_type, label: null }.
export async function resolveTarget(
  companyId: string,
  log: { entity_type: string | null; entity_id: string | null; old_values: Record<string, unknown> | null; new_values: Record<string, unknown> | null }
): Promise<{ type: string | null; label: string | null }> {
  const { entity_type, entity_id, old_values, new_values } = log;
  const snapshot: Record<string, unknown> = { ...(old_values || {}), ...(new_values || {}) };

  if (!entity_id) return { type: entity_type, label: null };

  if (entity_type === 'users' || entity_type === 'user_permissions') {
    const r = await pool.query('SELECT full_name, email FROM users WHERE id = $1 AND company_id = $2', [entity_id, companyId]);
    const row = r.rows[0];
    const label = (row?.full_name || row?.email || snapshot.full_name || snapshot.email || null) as string | null;
    return { type: 'users', label };
  }

  if (entity_type === 'employees') {
    const r = await pool.query('SELECT name FROM employees WHERE id = $1 AND company_id = $2', [entity_id, companyId]);
    const label = (r.rows[0]?.name || snapshot.name || null) as string | null;
    return { type: 'employees', label };
  }

  if (entity_type === 'payroll') {
    const r = await pool.query(
      `SELECT e.name FROM payroll p JOIN employees e ON e.id = p.employee_id WHERE p.id = $1 AND p.company_id = $2`,
      [entity_id, companyId]
    );
    let label = (r.rows[0]?.name || null) as string | null;
    if (!label && snapshot.employee_id) {
      const e = await pool.query('SELECT name FROM employees WHERE id = $1 AND company_id = $2', [snapshot.employee_id, companyId]);
      label = (e.rows[0]?.name || null) as string | null;
    }
    return { type: 'employees', label };
  }

  if (entity_type === 'job_role_permissions') {
    const r = await pool.query('SELECT name, name_en FROM job_roles WHERE id = $1 AND company_id = $2', [entity_id, companyId]);
    const label = (r.rows[0]?.name || r.rows[0]?.name_en || null) as string | null;
    return { type: 'job_roles', label };
  }

  return { type: entity_type, label: null };
}

async function getActorLabel(companyId: string, userId: string): Promise<string | null> {
  const r = await pool.query('SELECT full_name, email FROM users WHERE id = $1 AND company_id = $2', [userId, companyId]);
  const row = r.rows[0];
  return (row?.full_name || row?.email || null) as string | null;
}
