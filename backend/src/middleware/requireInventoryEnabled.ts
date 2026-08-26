import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { AppError } from './errorHandler';
import { asyncHandler } from '../utils/asyncHandler';

// Business-type module gating — added 2026-08-26 per Abdullah: a company that signs up
// as a pure services business (e.g. "خدمات إدارية ودعم" / Admin services & support) has
// no point-of-sale, no products, and no warehouses, and shouldn't be shipped a nav full
// of features it will never use. companies.inventory_enabled (MIGRATION_010 — originally
// only wired up to "hide raw-material/FIFO nav", never actually enforced anywhere) is
// reused here as the single flag driving all of it: POS/Shifts, Sales-from-a-shift,
// Products, Inventory overview, Raw materials (+ batches), Stock transfers, Suppliers,
// Purchase orders, and Waste tracking.
//
// Defaulted at signup from the selected industry (see auth.controller.ts's register()
// and RegisterPage.tsx's INDUSTRIES list) — true for every industry with physical
// products, false only for the explicit services case — and stays changeable any time
// after that from Company Settings > Preferences, same as the toggle already was.
//
// Same real-server-enforcement reasoning as requirePlan.ts: hiding the sidebar link is
// not enough, since anyone can call the API directly. Returns 403 + code
// INVENTORY_MODULE_DISABLED so the frontend can show a clear, actionable message instead
// of a generic "forbidden".
export function requireInventoryEnabled(featureLabel: string) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const companyId = req.auth?.companyId;
    if (!companyId) return next();

    const result = await pool.query(`SELECT inventory_enabled FROM companies WHERE id = $1`, [companyId]);
    const company = result.rows[0];
    if (!company) throw new AppError(404, 'Company not found');

    if (company.inventory_enabled === false) {
      throw new AppError(
        403,
        `${featureLabel} is turned off for this company — a services-only business doesn't need it by default. Turn it on from Company Settings > Preferences if you do.`,
        'INVENTORY_MODULE_DISABLED'
      );
    }
    next();
  });
}
