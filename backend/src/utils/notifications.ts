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
  } catch (err) {
    // Notifications are best-effort — never let a failure here break the caller's real action.
    // DIAGNOSTIC — was a bare swallow with zero trace, making a "notification never
    // arrived" report unfixable from the caller's side alone (no error, no row, nothing
    // to go on). Logged now so a real failure here shows up in the server logs instead
    // of vanishing silently; still never throws/rejects, same fire-and-forget contract.
    console.error('[notifyRoles] failed to notify', { companyId: input.companyId, roles: input.roles, type: input.type }, err);
  }
}

interface NotifyUsersInput {
  companyId: string;
  userIds: string[];
  type: string;
  title: string;
  body?: string;
  link?: string;
  excludeUserId?: string;
}

// notifyRoles' sibling for when the recipients are already known specific user ids
// (e.g. a resolved department manager, a ticket's assignee, a named job-role holder) —
// the Approval Engine's per-step notifications use this, since "who's eligible right
// now" is resolved live per request/step, not by a static role list. Deduped and
// self-notify-safe (excludeUserId), same fire-and-forget contract as notifyRoles.
export async function notifyUsers(input: NotifyUsersInput): Promise<void> {
  try {
    const targets = Array.from(new Set(input.userIds)).filter((id) => id && id !== input.excludeUserId);
    for (const userId of targets) {
      await pool.query(
        `INSERT INTO notifications (company_id, user_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.companyId, userId, input.type, input.title, input.body ?? null, input.link ?? null]
      );
    }
  } catch (err) {
    // Notifications are best-effort — never let a failure here break the caller's real action.
    // DIAGNOSTIC — see notifyRoles' matching comment above.
    console.error('[notifyUsers] failed to notify', { companyId: input.companyId, userIds: input.userIds, type: input.type }, err);
  }
}
