import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

const SELECT_COLUMNS = 'id, name, phone, email, points, notes, created_at, updated_at';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { search } = req.query;

  const params: unknown[] = [companyId];
  let where = 'company_id = $1';
  if (typeof search === 'string' && search.trim()) {
    params.push(`%${search.trim()}%`);
    where += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length})`;
  }

  const result = await pool.query(`SELECT ${SELECT_COLUMNS} FROM customers WHERE ${where} ORDER BY name`, params);
  res.status(200).json({ success: true, customers: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, phone, email, notes } = req.body ?? {};

  if (typeof name !== 'string' || !name.trim()) throw new AppError(400, 'name is required');

  const result = await pool.query(
    `INSERT INTO customers (company_id, name, phone, email, notes) VALUES ($1, $2, $3, $4, $5) RETURNING ${SELECT_COLUMNS}`,
    [companyId, name.trim(), phone || null, email || null, notes || null]
  );

  await logAudit({ companyId, userId: req.auth!.userId, action: 'customer_created', entityType: 'customers', entityId: result.rows[0].id, req });

  res.status(201).json({ success: true, customer: result.rows[0] });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { name, phone, email, notes } = req.body ?? {};

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => {
    sets.push(`${col} = $${i++}`);
    values.push(val);
  };
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) throw new AppError(400, 'name cannot be empty');
    set('name', name.trim());
  }
  if (phone !== undefined) set('phone', phone || null);
  if (email !== undefined) set('email', email || null);
  if (notes !== undefined) set('notes', notes || null);
  if (sets.length === 0) throw new AppError(400, 'No fields to update');

  sets.push('updated_at = NOW()');
  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE customers SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++} RETURNING ${SELECT_COLUMNS}`,
    values
  );
  if (!result.rows[0]) throw new AppError(404, 'Customer not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'customer_updated', entityType: 'customers', entityId: id as string, req });

  res.status(200).json({ success: true, customer: result.rows[0] });
});

// Manual points award/redemption — kept separate from the live sales flow (see
// migration comment). delta can be positive (award) or negative (redeem).
export const adjustPoints = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { delta, reason } = req.body ?? {};

  if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) {
    throw new AppError(400, 'delta must be a non-zero number');
  }

  const result = await pool.query(
    `UPDATE customers SET points = GREATEST(0, points + $1), updated_at = NOW()
     WHERE id = $2 AND company_id = $3 RETURNING ${SELECT_COLUMNS}`,
    [Math.round(delta), id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Customer not found');

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: delta > 0 ? 'customer_points_awarded' : 'customer_points_redeemed',
    entityType: 'customers',
    entityId: id as string,
    req,
  });

  res.status(200).json({ success: true, customer: result.rows[0] });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query('DELETE FROM customers WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (!result.rows[0]) throw new AppError(404, 'Customer not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'customer_deleted', entityType: 'customers', entityId: id as string, req });

  res.status(200).json({ success: true });
});
