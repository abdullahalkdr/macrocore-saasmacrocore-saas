import { Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { hashPassword, comparePassword } from '../utils/password';
import { signToken, verifyToken } from '../utils/jwt';
import { isValidEmail, isValidPassword } from '../utils/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

const EMPLOYEE_COUNT_RANGES = ['1', '2-5', '6-10', '11-20', '21-50', '51-100', '100+'];

// Signup wizard submits everything collected across its 3 steps in one call —
// keeps registration atomic (no orphaned user-without-a-company if someone
// abandons mid-wizard) and avoids needing a partial-signup session. See
// RegisterPage.tsx on the frontend for the step-by-step UI this feeds.
export const register = asyncHandler(async (req: Request, res: Response) => {
  const {
    email,
    password,
    company_name,
    full_name,
    first_name,
    last_name,
    job_title,
    phone,
    industry,
    employee_count_range,
    country,
    invite_emails,
  } = req.body ?? {};

  if (!isValidEmail(email)) throw new AppError(400, 'Invalid email format');
  if (!isValidPassword(password)) {
    throw new AppError(400, 'Password must be at least 8 characters and include a letter and a number');
  }
  if (typeof company_name !== 'string' || company_name.trim().length < 2) {
    throw new AppError(400, 'company_name is required');
  }
  if (employee_count_range !== undefined && employee_count_range !== null && !EMPLOYEE_COUNT_RANGES.includes(employee_count_range)) {
    throw new AppError(400, `employee_count_range must be one of ${EMPLOYEE_COUNT_RANGES.join(', ')}`);
  }
  const inviteList: string[] =
    Array.isArray(invite_emails) ? invite_emails.filter((e) => isValidEmail(e)).slice(0, 5) : [];

  const normalizedEmail = email.toLowerCase();
  const resolvedFullName =
    typeof full_name === 'string' && full_name.trim()
      ? full_name.trim()
      : [first_name, last_name].filter((v) => typeof v === 'string' && v.trim()).join(' ') || null;

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (existing.rows.length > 0) throw new AppError(409, 'Email already registered');

  if (inviteList.length > 0) {
    const clash = await pool.query('SELECT email FROM users WHERE email = ANY($1)', [inviteList.map((e) => e.toLowerCase())]);
    if (clash.rows.length > 0) throw new AppError(409, `Already registered: ${clash.rows.map((r) => r.email).join(', ')}`);
  }

  const client = await pool.connect();
  let company, user;
  const invitedUsers: { email: string; temp_password: string }[] = [];
  try {
    await client.query('BEGIN');

    const companyResult = await client.query(
      `INSERT INTO companies (name, industry, employee_count_range, country)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, plan, subscription_status, trial_start_date, trial_end_date, industry, employee_count_range, country`,
      [
        company_name.trim(),
        typeof industry === 'string' ? industry : null,
        typeof employee_count_range === 'string' ? employee_count_range : null,
        typeof country === 'string' && country.length === 2 ? country.toUpperCase() : 'KW',
      ]
    );
    company = companyResult.rows[0];

    const passwordHash = await hashPassword(password);
    const userResult = await client.query(
      `INSERT INTO users (company_id, email, password_hash, full_name, first_name, last_name, job_title, phone, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'admin')
       RETURNING id, email, full_name, first_name, last_name, job_title, phone, role, company_id`,
      [
        company.id,
        normalizedEmail,
        passwordHash,
        resolvedFullName,
        typeof first_name === 'string' ? first_name.trim() : null,
        typeof last_name === 'string' ? last_name.trim() : null,
        typeof job_title === 'string' ? job_title.trim() : null,
        typeof phone === 'string' ? phone.trim() : null,
      ]
    );
    user = userResult.rows[0];

    // Colleague invites — no email service wired up yet (see users.controller.ts),
    // so we create the accounts immediately with a temp password and hand them
    // back in the response for the admin to share directly.
    for (const inviteEmail of inviteList) {
      const tempPassword = crypto.randomBytes(6).toString('base64url');
      const inviteHash = await hashPassword(tempPassword);
      await client.query(
        `INSERT INTO users (company_id, email, password_hash, role) VALUES ($1, $2, $3, 'employee')`,
        [company.id, inviteEmail.toLowerCase(), inviteHash]
      );
      invitedUsers.push({ email: inviteEmail.toLowerCase(), temp_password: tempPassword });
    }

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
    invited_users: invitedUsers,
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

// Used by Settings > Profile > "تغيير كلمة المرور". Requires the current password
// (not just a valid session) so a stolen/left-open session can't silently take over
// the account.
export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const { current_password, new_password } = req.body ?? {};

  if (typeof current_password !== 'string' || !current_password) throw new AppError(400, 'current_password is required');
  if (!isValidPassword(new_password)) {
    throw new AppError(400, 'Password must be at least 8 characters and include a letter and a number');
  }

  const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  const row = result.rows[0];
  if (!row) throw new AppError(404, 'User not found');

  const valid = await comparePassword(current_password, row.password_hash);
  if (!valid) throw new AppError(401, 'Current password is incorrect');

  const newHash = await hashPassword(new_password);
  await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, userId]);

  await logAudit({ companyId: req.auth!.companyId, userId, action: 'password_changed', entityType: 'users', entityId: userId, req });

  res.status(200).json({ success: true, message: 'Password updated' });
});
