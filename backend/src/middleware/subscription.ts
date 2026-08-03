import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { AppError } from './errorHandler';
import { asyncHandler } from '../utils/asyncHandler';

// Runs after requireAuth (needs req.auth.companyId). Blocks every operational route
// once a company's trial has expired or its subscription isn't in good standing —
// 402 + code SUBSCRIPTION_INACTIVE, which frontend/src/api/client.ts catches and
// redirects to /subscription-expired instead of showing a raw error banner.
//
// Deliberately NOT mounted on /api/auth, /api/company (so a blocked company can
// still see its own status), /api/support/tickets (so they can still ask for help),
// or /api/admin (separately gated by requireAdminKey) — see app.ts.
//
// Allowlists 'trial' (while unexpired) and 'active'; anything else — including
// statuses that don't exist yet like 'past_due'/'cancelled'/'suspended' — is
// blocked by default. See docs/MIGRATION_029_subscription_enforcement.sql for why
// every pre-existing company was backfilled to 'active' before this went live.
export const requireActiveSubscription = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const companyId = req.auth?.companyId;
  if (!companyId) return next();

  const result = await pool.query(
    `SELECT plan, subscription_status, trial_end_date FROM companies WHERE id = $1`,
    [companyId]
  );
  const company = result.rows[0];
  if (!company) throw new AppError(404, 'Company not found');

  const trialStillValid =
    company.plan === 'trial' && company.subscription_status === 'trial' && (!company.trial_end_date || new Date(company.trial_end_date) > new Date());
  const isActive = company.subscription_status === 'active';

  if (!trialStillValid && !isActive) {
    throw new AppError(402, 'Your subscription is inactive — renew to keep using macrocore.', 'SUBSCRIPTION_INACTIVE');
  }
  next();
});
