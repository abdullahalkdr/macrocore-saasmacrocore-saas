import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { parsePagination } from '../utils/pagination';
import { SENSITIVE_ACTIONS } from '../utils/audit';

// Re-exported for backward compatibility — utils/audit.ts is now the source of truth
// (it needs the set too, to decide which logAudit() calls write to version_history,
// and a controller importing from a util is the right direction, not the reverse).
export { SENSITIVE_ACTIONS };

// Hard cap on a single CSV export (?format=csv) — still respects every filter below,
// just skips the page/limit constraint so the download matches "everything matching
// these filters" instead of "the current page." 5000 rows is generous for today's
// volume; if a company's filtered result ever exceeds it, narrowing the date range is
// the answer, not raising this number indefinitely (the roadmap's own growth
// assumption is millions of rows within a couple of years — no unbounded export).
const EXPORT_ROW_CAP = 5000;

// GET /audit-log/:id/changes — field-level diff detail for one entry (MIGRATION_067's
// version_history). Only ever has rows for the ~9 SENSITIVE_ACTIONS call sites that
// were updated to pass old/new values into logAudit(); every other entry returns an
// empty list, which the frontend treats as "no field-level detail recorded" rather
// than an error.
export const getChanges = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const result = await pool.query(
    `SELECT field_name, old_value, new_value, created_at FROM version_history
     WHERE audit_log_id = $1 AND company_id = $2
     ORDER BY field_name`,
    [id, companyId]
  );
  res.status(200).json({ success: true, changes: result.rows });
});

// Read-only — logAudit() (utils/audit.ts) has been writing to this table from nearly
// every controller in the app all along; this is just the first UI to actually view it.
export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { entity_type, action, user_id, date_from, date_to, sensitive_only, format } = req.query;

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

  // ?format=csv (the Export CSV button) ignores normal pagination and pulls up to
  // EXPORT_ROW_CAP matching rows in one request — same filters, same query shape,
  // just no page constraint. Still returns plain JSON; the frontend does the actual
  // CSV conversion via the same exportRowsToCsv() helper Expenses/Payroll/Reports
  // already use, so this endpoint doesn't need to know anything about CSV formatting.
  const isExport = format === 'csv';
  const { page, limit, offset } = isExport ? { page: 1, limit: EXPORT_ROW_CAP, offset: 0 } : parsePagination(req, 25, 100);

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
