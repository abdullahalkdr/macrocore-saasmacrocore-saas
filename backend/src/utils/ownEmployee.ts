import { pool } from '../db/pool';
import { AppError } from '../middleware/errorHandler';

// Resolves the calling user's own linked employee_id (users.employee_id, added in
// MIGRATION_040 to close code-audit finding #1: there was no link at all between a
// login account and its HR record, so any endpoint trusting employee_id from the
// client could be used to act on/see another employee's data). Shared by every
// controller that needs to pin a plain 'employee' caller to their own record instead
// of whatever employee_id the request claims — attendance clock-in/out/list first,
// leave requests create/list next.
export async function getOwnEmployeeId(userId: string, companyId: string): Promise<string> {
  const result = await pool.query(`SELECT employee_id FROM users WHERE id = $1 AND company_id = $2`, [userId, companyId]);
  const employeeId = result.rows[0]?.employee_id;
  if (!employeeId) throw new AppError(403, 'Your account is not linked to an employee record — ask an admin to link it');
  return employeeId as string;
}
