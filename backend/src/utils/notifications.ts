import { pool } from '../db/pool';

interface NotifyRolesInput {
  companyId: string;
  roles: string[];
  type: string;
  title: string;
  body?: string;
  link?: string;
  excludeUserId?: string;
}

// Fire-and-forget by design: callers should not await-fail their main action if this
// throws. One row per matching user in the company (see MIGRATION_025 comment for why).
export async function notifyRoles(input: NotifyRolesInput): Promise<void> {
  try {
    const users = await pool.query(
      `SELECT id FROM users WHERE company_id = $1 AND role = ANY($2::text[]) AND status = 'active' AND id != COALESCE($3, '00000000-0000-0000-0000-000000000000')`,
      [input.companyId, input.roles, input.excludeUserId ?? null]
    );
    for (const row of users.rows) {
      await pool.query(
        `INSERT INTO notifications (company_id, user_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.companyId, row.id, input.type, input.title, input.body ?? null, input.link ?? null]
      );
    }
  } catch {
    // Notifications are best-effort — never let a failure here break the caller's real action.
  }
}
