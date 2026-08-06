import { Request, Response } from 'express';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { pool } from '../db/pool';
import { hashPassword, comparePassword } from '../utils/password';
import {
  signToken,
  verifyToken,
  signGoogleSignupToken,
  verifyGoogleSignupToken,
  signEmailVerificationToken,
  verifyEmailVerificationToken,
} from '../utils/jwt';
import { isValidEmail, isValidPassword } from '../utils/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { env } from '../config/env';
import { sendEmail, verificationEmailHtml, passwordResetEmailHtml } from '../utils/email';

const EMPLOYEE_COUNT_RANGES = ['1', '2-5', '6-10', '11-20', '21-50', '51-100', '100+'];
const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID || undefined);

// Signup wizard submits everything collected across its 3 steps in one call —
// keeps registration atomic (no orphaned user-without-a-company if someone
// abandons mid-wizard) and avoids needing a partial-signup session. See
// RegisterPage.tsx on the frontend for the step-by-step UI this feeds.
export const register = asyncHandler(async (req: Request, res: Response) => {
  const {
    email,
    password,
    google_signup_token,
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

  // Two ways to reach here: normal email+password signup, or the tail end of the Google
  // flow (see googleStart below) — POST /auth/google already verified the Google account
  // and handed back a short-lived google_signup_token once the wizard's remaining steps
  // (profile + company info) are filled in. Either way we end up with a normalized email
  // and, only for the password path, a hash to store.
  let normalizedEmail: string;
  let googleSub: string | null = null;
  let resolvedFirstName: string | null;
  let resolvedLastName: string | null;
  let resolvedFullName: string | null;

  if (typeof google_signup_token === 'string' && google_signup_token) {
    let googlePayload;
    try {
      googlePayload = verifyGoogleSignupToken(google_signup_token);
    } catch {
      throw new AppError(401, 'Google sign-up session expired — please continue with Google again');
    }
    normalizedEmail = googlePayload.email;
    googleSub = googlePayload.googleSub;
    resolvedFirstName = typeof first_name === 'string' && first_name.trim() ? first_name.trim() : googlePayload.firstName;
    resolvedLastName = typeof last_name === 'string' && last_name.trim() ? last_name.trim() : googlePayload.lastName;
    resolvedFullName =
      typeof full_name === 'string' && full_name.trim()
        ? full_name.trim()
        : [resolvedFirstName, resolvedLastName].filter((v) => typeof v === 'string' && v.trim()).join(' ') || googlePayload.fullName;
  } else {
    if (!isValidEmail(email)) throw new AppError(400, 'Invalid email format');
    if (!isValidPassword(password)) {
      throw new AppError(400, 'Password must be at least 8 characters and include a letter and a number');
    }
    normalizedEmail = email.toLowerCase();
    resolvedFirstName = typeof first_name === 'string' ? first_name.trim() : null;
    resolvedLastName = typeof last_name === 'string' ? last_name.trim() : null;
    resolvedFullName =
      typeof full_name === 'string' && full_name.trim()
        ? full_name.trim()
        : [first_name, last_name].filter((v) => typeof v === 'string' && v.trim()).join(' ') || null;
  }

  if (typeof company_name !== 'string' || company_name.trim().length < 2) {
    throw new AppError(400, 'company_name is required');
  }
  if (employee_count_range !== undefined && employee_count_range !== null && !EMPLOYEE_COUNT_RANGES.includes(employee_count_range)) {
    throw new AppError(400, `employee_count_range must be one of ${EMPLOYEE_COUNT_RANGES.join(', ')}`);
  }
  const inviteList: string[] =
    Array.isArray(invite_emails) ? invite_emails.filter((e) => isValidEmail(e)).slice(0, 5) : [];

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

    const passwordHash = googleSub ? null : await hashPassword(password);
    // Google already verified this mailbox (see googleStart's `payload.email_verified`
    // check) — a Google signup is verified immediately. A password signup starts
    // unverified; the confirmation email goes out right after this transaction commits.
    const userResult = await client.query(
      `INSERT INTO users (company_id, email, password_hash, full_name, first_name, last_name, job_title, phone, role, google_id, auth_provider, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'admin', $9, $10, $11)
       RETURNING id, email, full_name, first_name, last_name, job_title, phone, role, company_id`,
      [
        company.id,
        normalizedEmail,
        passwordHash,
        resolvedFullName,
        resolvedFirstName,
        resolvedLastName,
        typeof job_title === 'string' ? job_title.trim() : null,
        typeof phone === 'string' ? phone.trim() : null,
        googleSub,
        googleSub ? 'google' : 'password',
        googleSub ? new Date() : null,
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

  // Best-effort, non-blocking: sendEmail() never throws (see utils/email.ts), so a
  // slow/down email provider never breaks registration itself — worst case the user
  // hits "resend verification" from the banner once logged in.
  if (!googleSub) {
    const emailVerifyToken = signEmailVerificationToken(user.id);
    void sendEmail({
      to: normalizedEmail,
      subject: 'فعّل بريدك الإلكتروني — macrocore',
      html: verificationEmailHtml(`${env.FRONTEND_URL}/verify-email?token=${emailVerifyToken}`),
    });
  }

  const token = signToken({ userId: user.id, companyId: company.id, role: user.role });

  res.status(200).json({
    success: true,
    user: { ...user, email_verified: !!googleSub },
    company,
    token,
    invited_users: invitedUsers,
    message: 'Account created. Trial expires in 14 days.',
  });
});

// Entry point for both "Continue with Google" on Login and on Register step 1. Verifies
// the Google id_token server-side, then branches:
//   - Email (or google_id) already has an account -> log them in directly, same shape as
//     login() below. First time a password-account's owner uses Google, we silently link
//     google_id onto it (Google already proved they own the mailbox).
//   - Brand new email -> no account created yet (there's no company to attach it to). We
//     hand back a short-lived signup token; the frontend skips straight to the wizard's
//     profile/company steps and POST /auth/register finishes the job.
export const googleStart = asyncHandler(async (req: Request, res: Response) => {
  const { id_token } = req.body ?? {};
  if (typeof id_token !== 'string' || !id_token) throw new AppError(400, 'id_token is required');
  if (!env.GOOGLE_CLIENT_ID) throw new AppError(500, 'Google sign-in is not configured');

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: id_token, audience: env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw new AppError(401, 'Invalid Google token');
  }
  if (!payload?.email || !payload.email_verified) throw new AppError(401, 'Google account email is not verified');

  const normalizedEmail = payload.email.toLowerCase();
  const googleSub = payload.sub;

  const result = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.role, u.status, u.company_id, u.google_id, u.email_verified_at,
            c.plan, c.trial_end_date
     FROM users u
     JOIN companies c ON c.id = u.company_id
     WHERE u.email = $1 OR u.google_id = $2`,
    [normalizedEmail, googleSub]
  );
  const row = result.rows[0];

  if (row) {
    if (row.status !== 'active') throw new AppError(403, 'Account is not active');
    if (!row.google_id) {
      await pool.query(
        `UPDATE users SET google_id = $1, auth_provider = 'google', updated_at = NOW() WHERE id = $2`,
        [googleSub, row.id]
      );
    }
    // Google just re-proved they own this mailbox — if the account was still sitting
    // unverified (e.g. they signed up with a password and never clicked the email link,
    // then later used "Continue with Google" instead), treat it as verified now too.
    if (!row.email_verified_at) {
      await pool.query(`UPDATE users SET email_verified_at = NOW() WHERE id = $1`, [row.id]);
      row.email_verified_at = new Date();
    }
    await logAudit({ companyId: row.company_id, userId: row.id, action: 'login_success', entityType: 'users', entityId: row.id, req });

    const token = signToken({ userId: row.id, companyId: row.company_id, role: row.role });
    let trialDaysRemaining: number | null = null;
    if (row.plan === 'trial' && row.trial_end_date) {
      const diffMs = new Date(row.trial_end_date).getTime() - Date.now();
      trialDaysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    }

    res.status(200).json({
      success: true,
      exists: true,
      user: { id: row.id, email: row.email, full_name: row.full_name, role: row.role, company_id: row.company_id, email_verified: true },
      token,
      trial_days_remaining: trialDaysRemaining,
    });
    return;
  }

  const signupToken = signGoogleSignupToken({
    email: normalizedEmail,
    googleSub,
    firstName: payload.given_name || null,
    lastName: payload.family_name || null,
    fullName: payload.name || null,
  });

  res.status(200).json({
    success: true,
    exists: false,
    signup_token: signupToken,
    email: normalizedEmail,
    first_name: payload.given_name || null,
    last_name: payload.family_name || null,
  });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (!isValidEmail(email) || typeof password !== 'string' || !password) {
    throw new AppError(400, 'Email and password are required');
  }

  const result = await pool.query(
    `SELECT u.id, u.email, u.password_hash, u.full_name, u.role, u.status, u.company_id, u.email_verified_at,
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
    user: {
      id: row.id,
      email: row.email,
      full_name: row.full_name,
      role: row.role,
      company_id: row.company_id,
      email_verified: !!row.email_verified_at,
    },
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

// Public — clicked from the emailed link. Deliberately does NOT require a session
// (someone might click it in a different browser than the one they signed up in).
export const verifyEmail = asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.body ?? {};
  if (typeof token !== 'string' || !token) throw new AppError(400, 'token is required');

  let payload;
  try {
    payload = verifyEmailVerificationToken(token);
  } catch {
    throw new AppError(400, 'Verification link is invalid or expired');
  }

  const result = await pool.query(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $1 RETURNING id, company_id, email_verified_at`,
    [payload.userId]
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, 'Account not found');

  await logAudit({ companyId: row.company_id, userId: row.id, action: 'email_verified', entityType: 'users', entityId: row.id, req });

  res.status(200).json({ success: true, message: 'Email verified' });
});

// Session-authenticated — the "إعادة إرسال" button shown on the unverified-email banner.
// Rate-limited by the same authLimiter as every other /auth/* route.
export const resendVerification = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const result = await pool.query('SELECT email, email_verified_at FROM users WHERE id = $1', [userId]);
  const row = result.rows[0];
  if (!row) throw new AppError(404, 'User not found');
  if (row.email_verified_at) {
    res.status(200).json({ success: true, message: 'Already verified' });
    return;
  }

  const emailVerifyToken = signEmailVerificationToken(userId);
  await sendEmail({
    to: row.email,
    subject: 'فعّل بريدك الإلكتروني — macrocore',
    html: verificationEmailHtml(`${env.FRONTEND_URL}/verify-email?token=${emailVerifyToken}`),
  });

  res.status(200).json({ success: true, message: 'Verification email sent' });
});

// Public. Always returns the same generic success message whether or not the email
// exists — a distinct "not found" response here is a classic account-enumeration leak
// (lets an attacker mass-check which emails have accounts on your platform).
export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body ?? {};
  if (!isValidEmail(email)) throw new AppError(400, 'Invalid email format');

  const result = await pool.query('SELECT id, auth_provider FROM users WHERE email = $1', [email.toLowerCase()]);
  const row = result.rows[0];

  // Google-only accounts have no password to reset — still respond generically (same
  // reasoning as above), the email itself can explain there's nothing to do here if we
  // wanted to, but keeping it silent is simplest and leaks nothing either way.
  if (row && row.auth_provider !== 'google') {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await pool.query(
      `UPDATE users SET password_reset_token_hash = $1, password_reset_expires_at = NOW() + INTERVAL '30 minutes' WHERE id = $2`,
      [tokenHash, row.id]
    );
    await sendEmail({
      to: email.toLowerCase(),
      subject: 'إعادة تعيين كلمة المرور — macrocore',
      html: passwordResetEmailHtml(`${env.FRONTEND_URL}/reset-password?token=${rawToken}`),
    });
  }

  res.status(200).json({ success: true, message: 'If that email exists, a reset link has been sent' });
});

// Public. Looks the raw token up by its hash (never store/compare the raw token itself)
// and checks it hasn't expired — one-shot by design, the columns are cleared on use so
// the same link can't be replayed.
export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { token, new_password } = req.body ?? {};
  if (typeof token !== 'string' || !token) throw new AppError(400, 'token is required');
  if (!isValidPassword(new_password)) {
    throw new AppError(400, 'Password must be at least 8 characters and include a letter and a number');
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await pool.query(
    `SELECT id, company_id FROM users WHERE password_reset_token_hash = $1 AND password_reset_expires_at > NOW()`,
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) throw new AppError(400, 'Reset link is invalid or expired');

  const newHash = await hashPassword(new_password);
  await pool.query(
    `UPDATE users SET password_hash = $1, password_reset_token_hash = NULL, password_reset_expires_at = NULL, updated_at = NOW() WHERE id = $2`,
    [newHash, row.id]
  );

  await logAudit({ companyId: row.company_id, userId: row.id, action: 'password_reset', entityType: 'users', entityId: row.id, req });

  res.status(200).json({ success: true, message: 'Password updated — you can log in now' });
});
