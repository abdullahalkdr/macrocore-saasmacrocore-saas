import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

const SELECT_COLUMNS = `
  id, code, name, phone, email, points, notes, relation, country, city, street,
  building_number, district, postal_code, contact_person, payment_terms,
  commercial_registration_number, created_at, updated_at
`;

const RELATION_VALUES = ['customer', 'vendor', 'both'] as const;

// Wafeq-style optional fields — every one is allowed to be null/empty, only `name` is
// required (see the "جهة إتصال" reference form: everything past "اسم المنشأة" is
// اختياري). No tax/VAT field — Kuwait has no VAT.
const OPTIONAL_STRING_FIELDS = [
  'phone',
  'email',
  'notes',
  'country',
  'city',
  'street',
  'building_number',
  'district',
  'postal_code',
  'contact_person',
  'payment_terms',
  'commercial_registration_number',
] as const;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { search, relation } = req.query;

  const params: unknown[] = [companyId];
  let where = 'company_id = $1';
  if (typeof search === 'string' && search.trim()) {
    params.push(`%${search.trim()}%`);
    where += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length} OR code ILIKE $${params.length})`;
  }
  if (typeof relation === 'string' && RELATION_VALUES.includes(relation as (typeof RELATION_VALUES)[number])) {
    params.push(relation);
    where += ` AND relation = $${params.length}`;
  }

  const result = await pool.query(`SELECT ${SELECT_COLUMNS} FROM customers WHERE ${where} ORDER BY created_at DESC`, params);
  res.status(200).json({ success: true, customers: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, relation } = req.body ?? {};

  if (typeof name !== 'string' || !name.trim()) throw new AppError(400, 'name is required');
  const relationValue = relation && RELATION_VALUES.includes(relation) ? relation : 'customer';

  // Auto-generated identifier ("المعرف" column in the reference table) — count-based,
  // not a DB sequence, matching the app's existing lightweight numbering approach
  // elsewhere (see sales_quotes/sales_invoices number generation). Fine at this scale;
  // not meant to survive concurrent double-submits perfectly.
  const countResult = await pool.query('SELECT COUNT(*)::int AS n FROM customers WHERE company_id = $1', [companyId]);
  const code = `C-${String(countResult.rows[0].n + 1).padStart(4, '0')}`;

  const values: unknown[] = [companyId, code, name.trim(), relationValue];
  const cols = ['company_id', 'code', 'name', 'relation'];
  for (const field of OPTIONAL_STRING_FIELDS) {
    const v = (req.body ?? {})[field];
    cols.push(field);
    values.push(v || null);
  }
  const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(', ');

  const result = await pool.query(
    `INSERT INTO customers (${cols.join(', ')}) VALUES (${placeholders}) RETURNING ${SELECT_COLUMNS}`,
    values
  );

  await logAudit({ companyId, userId: req.auth!.userId, action: 'customer_created', entityType: 'customers', entityId: result.rows[0].id, req });

  res.status(201).json({ success: true, customer: result.rows[0] });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { name, relation } = req.body ?? {};

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
  if (relation !== undefined) {
    if (!RELATION_VALUES.includes(relation)) throw new AppError(400, `relation must be one of ${RELATION_VALUES.join(', ')}`);
    set('relation', relation);
  }
  for (const field of OPTIONAL_STRING_FIELDS) {
    const v = (req.body ?? {})[field];
    if (v !== undefined) set(field, v || null);
  }
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
