import { pool } from '../db/pool';

// Shared by middleware/requirePermission.ts (route-level gate) and any controller
// that needs the same check inline — e.g. supportTickets.controller.ts's HR ticket
// isolation, which must apply per-row (a ticket's category), not just per-route.
export async function hasPermission(userId: string, permissionKey: string): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_key = $2', [userId, permissionKey]);
  return result.rows.length > 0;
}
