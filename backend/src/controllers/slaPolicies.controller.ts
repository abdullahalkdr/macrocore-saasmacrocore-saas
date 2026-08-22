import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const ROLES = ['admin', 'manager'];

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT id, priority, response_minutes, resolution_minutes, escalate_after_minutes, escalate_to_role, created_at, updated_at
     FROM sla_policies WHERE company_id = $1 ORDER BY priority`,
    [companyId]
  );
  res.status(200).json({ success: true, policies: result.rows });
});

// Upsert by priority — a company has at most one policy per priority level
// (sla_policies has UNIQUE (company_id, priority)).
export const upsert = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { priority } = req.params;
  const { response_minutes, resolution_minutes, escalate_after_minutes, escalate_to_role } = req.body ?? {};

  if (!PRIORITIES.includes(priority)) throw new AppError(400, `priority must be one of ${PRIORITIES.join(', ')}`);
  if (typeof response_minutes !== 'number' || response_minutes <= 0) throw new AppError(400, 'response_minutes must be a positive number');
  if (typeof resolution_minutes !== 'number' || resolution_minutes <= 0) throw new AppError(400, 'resolution_minutes must be a positive number');
  if (escalate_after_minutes !== undefined && escalate_after_minutes !== null) {
    if (typeof escalate_after_minutes !== 'number' || escalate_after_minutes <= 0) {
      throw new AppError(400, 'escalate_after_minutes must be a positive number or null');
    }
  }
  const finalEscalateToRole = typeof escalate_to_role === 'string' && ROLES.includes(escalate_to_role) ? escalate_to_role : 'admin';

  const result = await pool.query(
    `INSERT INTO sla_policies (company_id, priority, response_minutes, resolution_minutes, escalate_after_minutes, escalate_to_role)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (company_id, priority) DO UPDATE SET
       response_minutes = EXCLUDED.response_minutes,
       resolution_minutes = EXCLUDED.resolution_minutes,
       escalate_after_minutes = EXCLUDED.escalate_after_minutes,
       escalate_to_role = EXCLUDED.escalate_to_role,
       updated_at = NOW()
     RETURNING id, priority, response_minutes, resolution_minutes, escalate_after_minutes, escalate_to_role, updated_at`,
    [companyId, priority, response_minutes, resolution_minutes, escalate_after_minutes ?? null, finalEscalateToRole]
  );

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: 'sla_policy_updated',
    entityType: 'sla_policies',
    entityId: result.rows[0].id,
    req,
  });

  res.status(200).json({ success: true, policy: result.rows[0] });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { priority } = req.params;

  const result = await pool.query('DELETE FROM sla_policies WHERE company_id = $1 AND priority = $2 RETURNING id', [companyId, priority]);
  if (!result.rows[0]) throw new AppError(404, 'No policy set for this priority');

  res.status(200).json({ success: true });
});
