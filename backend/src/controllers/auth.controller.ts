import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { hashPassword, comparePassword } from '../utils/password';
import { signToken, verifyToken } from '../utils/jwt';
import { isValidEmail, isValidPassword } from '../utils/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

export const register = asyncHandler(async (req: Request, res: Response) => {
  const { email, password, company_name, full_name } = req.body ?? {};

  if (!isValidEmail(email)) throw new AppError(400, 'Invalid email format');
  if (!isValidPassword(password)) {
    throw new AppError(400, 'Password must be at least 8 characters and include a letter and a number');
  }
  if (typeof company_name !== 'string' || company_name.trim().length < 2) {
    throw new AppError(400, 'company_name is required');
  }

  const normalizedEmail = email.toLowerCase();

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (existing.rows.length > 0) throw new AppError(409, 'Email already registered');

  const client = await pool.connect();
  let company, user;
  try {
    await client.query('BEGIN');

    const companyResult = await client.query(
      `INSERT INTO companies (name)
       VALUES ($1)
       RETURNING id, name, plan, subscription_status, trial_start_date, trial_end_date`,
      [company_name.trim()]
    );
    company = companyResult.rows[0];

    const passwordHash = await hashPassword(password);
    const userResult = await client.query(
      `INSERT INTO users (company_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, 'admin')
       RETURNING id, email, full_name, role, company_id`,
      [company.id, normalizedEmail, passwordHash, typeof full_name === 'string' ? full_name : null]
    );
    user = userResult.rows[0];

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId: company.id, userId: user.id, action: 'user_registered', entityType: 'users', entityId: user.id, req });

  const token = signToken({ userId: user.id, companyId: company.id, role: user.role });

  res.status(200).json({
    success: true,
    user,
    company,
    token,
    message: 'Account created. Trial expires in 14 days.',
  });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (!isValidEmail(email) || typeof password !== 'string' || !password) {
    throw new AppError(400, 'Email and password are required');
  }

  const result = await pool.query(
    `SELECT u.id, u.email, u.password_hash, u.full_name, u.role, u.status, u.company_id,
            c.plan, c.trial_end_date
     FROM users u
     JOIN companies c ON c.id = u.company_id
     WHERE u.email = $1`,
    [email.toLowerCase()]
  );

  const row = result.rows[0];
  if (!row) throw new AppError(401, 'Invalid email or password');

  const valid = await comparePassword(password, row.password_hash);
  if (!valid) {
    await logAudit({ companyId: row.company_id, userId: row.id, action: 'login_failed', entityType: 'users', entityId: row.id, req });
    throw new AppError(401, 'Invalid email or password');
  }

  if (row.status !== 'active') throw new AppError(403, 'Account is not active');

  await logAudit({ companyId: row.company_id, userId: row.id, action: 'login_success', entityType: 'users', entityId: row.id, req });

  const token = signToken({ userId: row.id, companyId: row.company_id, role: row.role });

  let trialDaysRemaining: number | null = null;
  if (row.plan === 'trial' && row.trial_end_date) {
    const diffMs = new Date(row.trial_end_date).getTime() - Date.now();
    trialDaysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  }

  res.status(200).json({
    success: true,
    user: { id: row.id, email: row.email, full_name: row.full_name, role: row.role, company_id: row.company_id },
    token,
    trial_days_remaining: trialDaysRemaining,
  });
});

// Stateless refresh: verify signature while ignoring expiry, confirm the user
// is still active, issue a fresh token. No revocation list yet — see API_DOCS.md.
export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) throw new AppError(401, 'No token provided');
  const oldToken = authHeader.slice(7);

  let payload;
  try {
    payload = verifyToken(oldToken, { ignoreExpiration: true });
  } catch {
    throw new AppError(401, 'Invalid token');
  }

  const result = await pool.query('SELECT id, role, status, company_id FROM users WHERE id = $1', [payload.userId]);
  const user = result.rows[0];
  if (!user || user.status !== 'active') throw new AppError(401, 'User no longer active');

  const token = signToken({ userId: user.id, companyId: user.company_id, role: user.role });
  res.status(200).json({ token });
});
