import { Request } from 'express';
import { pool } from '../db/pool';

interface AuditParams {
  companyId: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  req: Request;
}

export async function logAudit({ companyId, userId, action, entityType, entityId, req }: AuditParams): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [companyId, userId || null, action, entityType, entityId || null, req.ip, req.headers['user-agent'] || null]
    );
  } catch (err) {
    // ponytail: an audit-log failure should never fail the request it's logging.
    // console for now, wire to real alerting once this matters in prod.
    console.error('audit log failed:', (err as Error).message);
  }
}
