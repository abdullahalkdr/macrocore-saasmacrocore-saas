import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { AppError } from './errorHandler';
import { asyncHandler } from '../utils/asyncHandler';
import { planLevelOf, PLAN_NAMES } from '../config/planFeatures';
import { env } from '../config/env';

// Runs after requireAuth + requireActiveSubscription. Real, server-side feature
// gating — per docs/macrocore-خارطة-طريق.md's own warning, hiding a nav link on the
// frontend is not enough, since anyone can call the API directly. Returns 403 + code
// PLAN_UPGRADE_REQUIRED with a plain-language upsell message instead of a generic
// "forbidden", so the frontend can surface something a customer actually understands.
export function requirePlanLevel(minLevel: number, featureLabel: string) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    // GLOBAL UNLOCK (dev/test only, env.BYPASS_PLAN_GATING — see env.ts and
    // .env.example) — every silver()/gold() route in app.ts funnels through this one
    // function, so short-circuiting here is enough to unlock all of them at once
    // without touching app.ts, the DB schema, or any company's stored plan value.
    if (env.BYPASS_PLAN_GATING) return next();

    const companyId = req.auth?.companyId;
    if (!companyId) return next();

    const result = await pool.query(`SELECT plan FROM companies WHERE id = $1`, [companyId]);
    const company = result.rows[0];
    if (!company) throw new AppError(404, 'Company not found');

    if (planLevelOf(company.plan) < minLevel) {
      const requiredPlanName = PLAN_NAMES[minLevel] ?? 'a higher';
      throw new AppError(
        403,
        `${featureLabel} requires the ${requiredPlanName} plan or higher — upgrade from Account settings or contact us.`,
        'PLAN_UPGRADE_REQUIRED'
      );
    }
    next();
  });
}
