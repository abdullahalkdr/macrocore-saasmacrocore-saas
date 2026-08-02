import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';

// Read-only — logAudit() (utils/audit.ts) has been writing to this table from nearly
// every controller in the app all along; this is just the first UI to actually view it.
export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { entity_type, action, user_id, date_from, date_to, limit } = req.query;

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

  const safeLimit = Math.min(Number(limit) || 200, 500);

  const result = await pool.query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.ip_address, a.created_at,
            u.full_name AS user_name, u.email AS user_email
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE ${where}
     ORDER BY a.created_at DESC
     LIMIT ${safeLimit}`,
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
    audit_logs: result.rows,
    actions: actionsResult.rows.map((r) => r.action),
    entity_types: entityTypesResult.rows.map((r) => r.entity_type),
  });
});
