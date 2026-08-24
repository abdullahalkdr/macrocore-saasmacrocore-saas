import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { isForeignKeyViolation } from '../utils/dbErrors';
import { planLevelOf, BRONZE_LOCATION_LIMIT } from '../config/planFeatures';

// Enterprise Facility Management upgrade (MIGRATION_050) — kiosk/warehouse were the
// only two types this app ever created; retail/dark_kitchen/head_office added to match
// the DB-level CHECK the migration introduces for the first time (chk_locations_type).
const LOCATION_TYPES = ['kiosk', 'warehouse', 'retail', 'dark_kitchen', 'head_office'];

// days_until_expiry computed at query time, not stored — same COALESCE(expiry_date::date
// - CURRENT_DATE, NULL) pattern companyFiles.controller.ts already uses for the same
// reason: a stored value goes stale the instant it's read on any day other than the one
// it was computed on. LEFT JOIN employees for manager_name — same shape as
// employees.controller.ts's department LEFT JOIN (MIGRATION_048).
const SELECT_COLUMNS = `l.id, l.name, l.address, l.area, l.type,
  l.manager_id, m.name AS manager_name,
  l.cost_center_code, l.contact_phone, l.gps_coordinates,
  l.municipality_license, l.license_expiry_date, l.lease_expiry_date,
  COALESCE(l.license_expiry_date::date - CURRENT_DATE, NULL) AS license_days_until_expiry,
  COALESCE(l.lease_expiry_date::date - CURRENT_DATE, NULL) AS lease_days_until_expiry,
  l.created_at`;

const FROM_JOIN = `FROM locations l LEFT JOIN employees m ON m.id = l.manager_id AND m.company_id = l.company_id`;

// Shared by create() and update() — manager_id must be a real employees row in the
// same company, exact same cross-tenant-validation shape as employees.controller.ts's
// department_id/location_id checks (MIGRATION_048's precedent, reused again in
// MIGRATION_049 for departments.manager_id, now here for locations.manager_id).
async function assertManagerInCompany(managerId: unknown, companyId: string) {
  if (!managerId) return;
  const emp = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [managerId, companyId]);
  if (emp.rows.length === 0) throw new AppError(400, 'manager_id not found');
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE l.company_id = $1 ORDER BY l.created_at DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, locations: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const {
    name, address, area, type,
    manager_id, cost_center_code, contact_phone, gps_coordinates,
    municipality_license, license_expiry_date, lease_expiry_date,
  } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (type !== undefined && !LOCATION_TYPES.includes(type)) {
    throw new AppError(400, `type must be one of ${LOCATION_TYPES.join(', ')}`);
  }
  await assertManagerInCompany(manager_id, companyId);

  // "Multiple locations" is a Silver+ feature (docs/macrocore-خارطة-طريق.md) — Bronze
  // is priced for a single kiosk/branch. This is a quantity cap rather than a route
  // gate: every plan, Bronze included, still needs to create its one location to open
  // a shift at all (see shifts.controller.ts open()).
  const companyResult = await pool.query(`SELECT plan FROM companies WHERE id = $1`, [companyId]);
  if (planLevelOf(companyResult.rows[0]?.plan) < 2) {
    const countResult = await pool.query(`SELECT COUNT(*)::int AS n FROM locations WHERE company_id = $1`, [companyId]);
    if (countResult.rows[0].n >= BRONZE_LOCATION_LIMIT) {
      throw new AppError(
        403,
        `The Bronze plan includes ${BRONZE_LOCATION_LIMIT} location — upgrade to Silver or higher to add more.`,
        'PLAN_UPGRADE_REQUIRED'
      );
    }
  }

  const inserted = await pool.query(
    `INSERT INTO locations (
       company_id, name, address, area, type,
       manager_id, cost_center_code, contact_phone, gps_coordinates,
       municipality_license, license_expiry_date, lease_expiry_date
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      companyId, name.trim(), address ?? null, area ?? null, type ?? 'kiosk',
      manager_id ?? null, cost_center_code ?? null, contact_phone ?? null, gps_coordinates ?? null,
      municipality_license ?? null, license_expiry_date ?? null, lease_expiry_date ?? null,
    ]
  );

  // Re-select through the same SELECT_COLUMNS/JOIN as list() so the response carries
  // manager_name and the computed days-until-expiry fields too, not a partial row.
  const result = await pool.query(`SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE l.id = $1`, [inserted.rows[0].id]);
  const location = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'location_created', entityType: 'locations', entityId: location.id, req });

  res.status(201).json({ success: true, location });
});

// Lets a company reclassify an existing location (e.g. the one auto-created/defaulted
// to 'kiosk' by MIGRATION_006 is actually used as a warehouse) and now also carry the
// Enterprise Facility fields added in MIGRATION_050, without recreating it.
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const {
    name, address, area, type,
    manager_id, cost_center_code, contact_phone, gps_coordinates,
    municipality_license, license_expiry_date, lease_expiry_date,
  } = req.body ?? {};

  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) {
    throw new AppError(400, 'name must be a non-empty string when provided');
  }
  if (type !== undefined && !LOCATION_TYPES.includes(type)) {
    throw new AppError(400, `type must be one of ${LOCATION_TYPES.join(', ')}`);
  }
  if (manager_id !== undefined) await assertManagerInCompany(manager_id, companyId);

  const existing = await pool.query(
    `SELECT id, name, address, area, type, manager_id, cost_center_code, contact_phone,
            gps_coordinates, municipality_license, license_expiry_date, lease_expiry_date
     FROM locations WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!existing.rows[0]) throw new AppError(404, 'Location not found');
  const current = existing.rows[0];

  await pool.query(
    `UPDATE locations SET
       name = $1, address = $2, area = $3, type = $4,
       manager_id = $5, cost_center_code = $6, contact_phone = $7, gps_coordinates = $8,
       municipality_license = $9, license_expiry_date = $10, lease_expiry_date = $11,
       updated_at = NOW()
     WHERE id = $12 AND company_id = $13`,
    [
      name !== undefined ? name.trim() : current.name,
      address !== undefined ? address : current.address,
      area !== undefined ? area : current.area,
      type !== undefined ? type : current.type,
      manager_id !== undefined ? (manager_id || null) : current.manager_id,
      cost_center_code !== undefined ? cost_center_code : current.cost_center_code,
      contact_phone !== undefined ? contact_phone : current.contact_phone,
      gps_coordinates !== undefined ? gps_coordinates : current.gps_coordinates,
      municipality_license !== undefined ? municipality_license : current.municipality_license,
      license_expiry_date !== undefined ? (license_expiry_date || null) : current.license_expiry_date,
      lease_expiry_date !== undefined ? (lease_expiry_date || null) : current.lease_expiry_date,
      id,
      companyId,
    ]
  );

  const result = await pool.query(`SELECT ${SELECT_COLUMNS} ${FROM_JOIN} WHERE l.id = $1`, [id]);
  const location = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'location_updated', entityType: 'locations', entityId: location.id, req });

  res.status(200).json({ success: true, location });
});

// Admin/manager only (see routes). Blocked by a FK violation if the location has
// shifts, raw material batches, stock transfers, or expenses pointing at it — there's
// no "inactive" flag on locations, so the fix is to reassign/clear those first.
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM locations WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
    if (result.rows.length === 0) throw new AppError(404, 'Location not found');
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new AppError(409, 'This location is in use (shifts, inventory, or expenses reference it) and cannot be deleted');
    }
    throw err;
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'location_deleted', entityType: 'locations', entityId: id as string, req });

  res.status(200).json({ success: true });
});
