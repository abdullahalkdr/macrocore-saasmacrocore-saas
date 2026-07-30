import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

const LOCATION_TYPES = ['kiosk', 'warehouse'];

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT id, name, address, area, type, created_at FROM locations WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, locations: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, address, area, type } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (type !== undefined && !LOCATION_TYPES.includes(type)) {
    throw new AppError(400, `type must be one of ${LOCATION_TYPES.join(', ')}`);
  }

  const result = await pool.query(
    `INSERT INTO locations (company_id, name, address, area, type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, address, area, type, created_at`,
    [companyId, name.trim(), address ?? null, area ?? null, type ?? 'kiosk']
  );
  const location = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'location_created', entityType: 'locations', entityId: location.id, req });

  res.status(201).json({ success: true, location });
});

// Lets a company reclassify an existing location (e.g. the one auto-created/defaulted
// to 'kiosk' by MIGRATION_006 is actually used as a warehouse) without recreating it.
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { name, address, area, type } = req.body ?? {};

  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) {
    throw new AppError(400, 'name must be a non-empty string when provided');
  }
  if (type !== undefined && !LOCATION_TYPES.includes(type)) {
    throw new AppError(400, `type must be one of ${LOCATION_TYPES.join(', ')}`);
  }

  const existing = await pool.query(`SELECT id, name, address, area, type FROM locations WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Location not found');
  const current = existing.rows[0];

  const result = await pool.query(
    `UPDATE locations SET name = $1, address = $2, area = $3, type = $4, updated_at = NOW()
     WHERE id = $5 AND company_id = $6
     RETURNING id, name, address, area, type, updated_at`,
    [
      name !== undefined ? name.trim() : current.name,
      address !== undefined ? address : current.address,
      area !== undefined ? area : current.area,
      type !== undefined ? type : current.type,
      id,
      companyId,
    ]
  );
  const location = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'location_updated', entityType: 'locations', entityId: location.id, req });

  res.status(200).json({ success: true, location });
});
