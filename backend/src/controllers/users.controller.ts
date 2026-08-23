import { Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { isValidEmail } from '../utils/validate';
import { hashPassword } from '../utils/password';
import { parsePagination } from '../utils/pagination';
import { logAudit } from '../utils/audit';

const ROLES = ['admin', 'manager', 'employee', 'viewer'];
const STATUSES = ['active', 'suspended', 'inactive'];

// Settings > Profile — the logged-in user editing their own info. Deliberately
// separate from update() below: that one is admin/manager managing OTHER users
// (role/status), this one is self-service and can't touch role/status.
export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT id, email, full_name, first_name, last_name, job_title, phone, role, company_id, created_at
     FROM users WHERE id = $1`,
    [req.auth!.userId]
  );
  const user = result.rows[0];
  if (!user) throw new AppError(404, 'User not found');
  res.status(200).json({ success: true, user });
});

export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const { first_name, last_name, job_title, phone } = req.body ?? {};

  const sets: string[] = [];
  const params: unknown[] = [];

  if (first_name !== undefined) {
    if (typeof first_name !== 'string') throw new AppError(400, 'first_name must be a string');
    params.push(first_name.trim() || null);
    sets.push(`first_name = $${params.length}`);
  }
  if (last_name !== undefined) {
    if (typeof last_name !== 'string') throw new AppError(400, 'last_name must be a string');
    params.push(last_name.trim() || null);
    sets.push(`last_name = $${params.length}`);
  }
  if (job_title !== undefined) {
    if (typeof job_title !== 'string') throw new AppError(400, 'job_title must be a string');
    params.push(job_title.trim() || null);
    sets.push(`job_title = $${params.length}`);
  }
  if (phone !== undefined) {
    if (typeof phone !== 'string') throw new AppError(400, 'phone must be a string');
    params.push(phone.trim() || null);
    sets.push(`phone = $${params.length}`);
  }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');

  // Keep full_name (used across the rest of the app — audit logs, employee links, etc.)
  // in sync whenever either name half changes.
  const current = await pool.query('SELECT first_name, last_name FROM users WHERE id = $1', [userId]);
  if (!current.rows[0]) throw new AppError(404, 'User not found');
  const nextFirst = first_name !== undefined ? (typeof first_name === 'string' ? first_name.trim() : null) : current.rows[0].first_name;
  const nextLast = last_name !== undefined ? (typeof last_name === 'string' ? last_name.trim() : null) : current.rows[0].last_name;
  const combinedName = [nextFirst, nextLast].filter(Boolean).join(' ');
  if (combinedName) {
    params.push(combinedName);
    sets.push(`full_name = $${params.length}`);
  }

  sets.push('updated_at = NOW()');
  params.push(userId);

  const result = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, email, full_name, first_name, last_name, job_title, phone, role, company_id`,
    params
  );
  const user = result.rows[0];

  await logAudit({ companyId: req.auth!.companyId, userId, action: 'profile_updated', entityType: 'users', entityId: userId, req });

  res.status(200).json({ success: true, user });
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { page, limit, offset } = parsePagination(req);
  const role = typeof req.query.role === 'string' ? req.query.role : null;

  const params: unknown[] = [companyId];
  let where = 'company_id = $1';
  // Same condition, u.-qualified — the joined query below (employees/departments,
  // MIGRATION_048) needs it, since an unqualified company_id would be ambiguous
  // once joined (both employees and departments have their own company_id too).
  let whereJoined = 'u.company_id = $1';
  if (role) {
    params.push(role);
    where += ` AND role = $${params.length}`;
    whereJoined += ` AND u.role = $${params.length}`;
  }

  const totalResult = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE ${where}`, params);
  params.push(limit, offset);
  // department_id/department_name(_en) resolved through users.employee_id ->
  // employees.department_id -> departments (MIGRATION_048) — department
  // lives on the employee record, not duplicated onto users (see that
  // migration's decision 3). A user with no linked employee_id, or an
  // employee with no department set, just comes back with department_name
  // null — the Support Tickets assignee picker falls back to "no
  // department" for those, same as it always showed a flat name before.
  const usersResult = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.first_name, u.last_name, u.phone, u.job_title, u.role, u.status,
            u.employee_id, u.created_at, d.id AS department_id, d.name AS department_name, d.name_en AS department_name_en
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ${whereJoined}
     ORDER BY u.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.status(200).json({ success: true, users: usersResult.rows, total: totalResult.rows[0].n, page });
});

// No email service yet (Phase 3) — returns a temp_password instead of "invitation sent".
// Swap for a real invite flow (email + set-password link) once SendGrid is wired up.
export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { email, name, role } = req.body ?? {};

  if (!isValidEmail(email)) throw new AppError(400, 'Invalid email format');
  if (typeof name !== 'string' || name.trim().length < 2) throw new AppError(400, 'name is required');
  const finalRole = typeof role === 'string' && ROLES.includes(role) ? role : 'employee';

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows.length > 0) throw new AppError(409, 'Email already registered');

  const tempPassword = crypto.randomBytes(6).toString('base64url'); // e.g. "aZ3-kQ9x1F2z"
  const passwordHash = await hashPassword(tempPassword);

  const result = await pool.query(
    `INSERT INTO users (company_id, email, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, full_name, role, status, created_at`,
    [companyId, email.toLowerCase(), passwordHash, name.trim(), finalRole]
  );
  const user = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'user_created', entityType: 'users', entityId: user.id, req });

  res.status(201).json({ success: true, user, temp_password: tempPassword, message: 'User created. Share the temp_password with them directly — no email service wired up yet.' });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { role, status, full_name, email, new_password, employee_id } = req.body ?? {};

  const sets: string[] = [];
  const params: unknown[] = [];

  if (role !== undefined) {
    if (!ROLES.includes(role)) throw new AppError(400, `role must be one of ${ROLES.join(', ')}`);
    params.push(role);
    sets.push(`role = $${params.length}`);
  }
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw new AppError(400, `status must be one of ${STATUSES.join(', ')}`);
    params.push(status);
    sets.push(`status = $${params.length}`);
  }
  if (full_name !== undefined) {
    if (typeof full_name !== 'string') throw new AppError(400, 'full_name must be a string');
    params.push(full_name);
    sets.push(`full_name = $${params.length}`);
  }
  if (email !== undefined) {
    if (!isValidEmail(email)) throw new AppError(400, 'Invalid email format');
    const clash = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email.toLowerCase(), id]);
    if (clash.rows.length > 0) throw new AppError(409, 'Email already registered');
    params.push(email.toLowerCase());
    sets.push(`email = $${params.length}`);
  }

  // Links this login account to its HR record so attendance.controller.ts can resolve
  // "who am I" -> employee_id server-side instead of trusting the client (MIGRATION_040).
  // null unlinks on purpose (e.g. the employee record was deleted, or the link was wrong).
  if (employee_id !== undefined) {
    if (employee_id === null) {
      sets.push('employee_id = NULL');
    } else {
      if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id must be a string or null');
      const employee = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [employee_id, companyId]);
      if (!employee.rows[0]) throw new AppError(400, 'employee_id not found for this company');
      const clash = await pool.query('SELECT id FROM users WHERE employee_id = $1 AND id != $2', [employee_id, id]);
      if (clash.rows[0]) throw new AppError(409, 'This employee is already linked to another account');
      params.push(employee_id);
      sets.push(`employee_id = $${params.length}`);
    }
  }

  // Admin-only password reset — a manager can edit role/status/name/email above,
  // but resetting someone's login password is reserved for admins. Also blocked
  // on your own account: use /auth/change-password there (requires current password).
  if (new_password !== undefined) {
    if (req.auth!.role !== 'admin') throw new AppError(403, 'Only an admin can reset another user’s password');
    if (id === req.auth!.userId) throw new AppError(400, 'Use change password (in your profile) to change your own password');
    if (typeof new_password !== 'string' || new_password.length < 6) throw new AppError(400, 'new_password must be at least 6 characters');
    const passwordHash = await hashPassword(new_password);
    params.push(passwordHash);
    sets.push(`password_hash = $${params.length}`);
  }

  if (sets.length === 0) throw new AppError(400, 'Nothing to update');

  sets.push('updated_at = NOW()');
  params.push(id, companyId);

  const result = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND company_id = $${params.length}
     RETURNING id, email, full_name, role, status, employee_id`,
    params
  );
  const user = result.rows[0];
  if (!user) throw new AppError(404, 'User not found');

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: new_password !== undefined ? 'user_password_reset' : 'user_updated',
    entityType: 'users',
    entityId: user.id,
    req,
  });

  res.status(200).json({ success: true, user });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  if (id === req.auth!.userId) throw new AppError(400, "You can't delete your own account");

  const target = await pool.query('SELECT role FROM users WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!target.rows[0]) throw new AppError(404, 'User not found');

  if (target.rows[0].role === 'admin') {
    const admins = await pool.query(
      "SELECT COUNT(*)::int AS n FROM users WHERE company_id = $1 AND role = 'admin' AND status = 'active'",
      [companyId]
    );
    if (admins.rows[0].n <= 1) throw new AppError(400, 'Cannot delete the last active admin');
  }

  await pool.query('DELETE FROM users WHERE id = $1 AND company_id = $2', [id, companyId]);

  await logAudit({ companyId, userId: req.auth!.userId, action: 'user_deleted', entityType: 'users', entityId: id as string, req });

  res.status(200).json({ success: true, message: 'User deleted' });
});
