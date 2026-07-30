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

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { page, limit, offset } = parsePagination(req);
  const role = typeof req.query.role === 'string' ? req.query.role : null;

  const params: unknown[] = [companyId];
  let where = 'company_id = $1';
  if (role) {
    params.push(role);
    where += ` AND role = $${params.length}`;
  }

  const totalResult = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE ${where}`, params);
  params.push(limit, offset);
  const usersResult = await pool.query(
    `SELECT id, email, full_name, role, status, created_at FROM users
     WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
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
  const { role, status, full_name } = req.body ?? {};

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
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');

  sets.push('updated_at = NOW()');
  params.push(id, companyId);

  const result = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND company_id = $${params.length}
     RETURNING id, email, full_name, role, status`,
    params
  );
  const user = result.rows[0];
  if (!user) throw new AppError(404, 'User not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'user_updated', entityType: 'users', entityId: user.id, req });

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
