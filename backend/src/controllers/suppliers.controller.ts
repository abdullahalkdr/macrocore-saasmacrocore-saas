import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { isForeignKeyViolation } from '../utils/dbErrors';

const SELECT_COLUMNS = 'id, name, contact_name, phone, email, notes, created_at';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(`SELECT ${SELECT_COLUMNS} FROM suppliers WHERE company_id = $1 ORDER BY name ASC`, [companyId]);
  res.status(200).json({ success: true, suppliers: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, contact_name, phone, email, notes } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');

  const result = await pool.query(
    `INSERT INTO suppliers (company_id, name, contact_name, phone, email, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SELECT_COLUMNS}`,
    [companyId, name.trim(), contact_name ?? null, phone ?? null, email ?? null, notes ?? null]
  );
  const supplier = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'supplier_created', entityType: 'suppliers', entityId: supplier.id, req });

  res.status(201).json({ success: true, supplier });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { name, contact_name, phone, email, notes } = req.body ?? {};

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => {
    sets.push(`${col} = $${i++}`);
    values.push(val);
  };

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name must be a non-empty string');
    set('name', name.trim());
  }
  if (contact_name !== undefined) set('contact_name', contact_name || null);
  if (phone !== undefined) set('phone', phone || null);
  if (email !== undefined) set('email', email || null);
  if (notes !== undefined) set('notes', notes || null);

  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push('updated_at = NOW()');
  values.push(id, companyId);
  const result = await pool.query(
    `UPDATE suppliers SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++} RETURNING ${SELECT_COLUMNS}`,
    values
  );
  const supplier = result.rows[0];
  if (!supplier) throw new AppError(404, 'Supplier not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'supplier_updated', entityType: 'suppliers', entityId: id as string, req });

  res.status(200).json({ success: true, supplier });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM suppliers WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
    if (result.rows.length === 0) throw new AppError(404, 'Supplier not found');
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new AppError(409, 'This supplier is linked to raw materials and cannot be deleted — unlink them first');
    }
    throw err;
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'supplier_deleted', entityType: 'suppliers', entityId: id as string, req });

  res.status(200).json({ success: true });
});
