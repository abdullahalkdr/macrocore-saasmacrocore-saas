import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { parsePagination } from '../utils/pagination';

// Actions worth flagging as "sensitive" in the UI: role/permission changes, deleting a
// person, and anything that touches payroll money. Classified at READ time (not a
// stored column) on purpose — it applies retroactively to every historical row, and
// adding a new sensitive action later is a one-line change here, no migration needed.
// Phase 02 (real-time alerts) and Phase 04 (compliance reports) are expected to import
// this same set rather than keeping their own copy — see the Activity Log roadmap.
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

// Read-only — logAudit() (utils/audit.ts) has been writing to this table from nearly
// every controller in the app all along; this is just the first UI to actually view it.
export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { entity_type, action, user_id, date_from, date_to, sensitive_only } = req.query;
  // Real offset pagination — previously this endpoint only accepted a raw ?limit
  // capped at 500 with no way to page past it. 25/page, 100 max, matches the same
  // parsePagination() convention already used by users.controller.ts's list().
  const { page, limit, offset } = parsePagination(req, 25, 100);

  const params: unknown[] = [companyId];
  let where = 'a.company_id = $1';
  if (typeof entity_type === 'string' && entity_type) {
    params.push(entity_type);
    where += ` AND a.entity_type = $${params.length}`;
  }
  if (typeof action === 'string' && action) {
    params.push(action);
    where += ` AND a.action = $${params.length}`;
  }
  if (typeof user_id === 'string' && user_id) {
    params.push(user_id);
    where += ` AND a.user_id = $${params.length}`;
  }
  if (typeof date_from === 'string' && date_from) {
    params.push(date_from);
    where += ` AND a.created_at::date >= $${params.length}`;
  }
  if (typeof date_to === 'string' && date_to) {
    params.push(date_to);
    where += ` AND a.created_at::date <= $${params.length}`;
  }
  if (sensitive_only === 'true') {
    params.push(Array.from(SENSITIVE_ACTIONS));
    where += ` AND a.action = ANY($${params.length})`;
  }

  // COUNT(*) on the same filter — fine at today's row counts. Once audit_logs is in
  // the millions (the roadmap's own growth assumption), this is the first query to
  // revisit: approximate count, or drop page totals for cursor-based pagination.
  const totalResult = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs a WHERE ${where}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.ip_address, a.created_at,
            u.full_name AS user_name, u.email AS user_email
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE ${where}
     ORDER BY a.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const actionsResult = await pool.query(
    `SELECT DISTINCT action FROM audit_logs WHERE company_id = $1 ORDER BY action`,
    [companyId]
  );
  const entityTypesResult = await pool.query(
    `SELECT DISTINCT entity_type FROM audit_logs WHERE company_id = $1 ORDER BY entity_type`,
    [companyId]
  );

  res.status(200).json({
    success: true,
    audit_logs: result.rows.map((r) => ({ ...r, is_sensitive: SENSITIVE_ACTIONS.has(r.action) })),
    actions: actionsResult.rows.map((r) => r.action),
    entity_types: entityTypesResult.rows.map((r) => r.entity_type),
    total: totalResult.rows[0].n,
    page,
    limit,
  });
});
