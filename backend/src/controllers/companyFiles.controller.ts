import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

const CATEGORIES = ['license', 'contract', 'certificate', 'other'];

const SELECT_COLUMNS = `id, title, category, file_name, issue_date, expiry_date, notes,
  COALESCE(expiry_date::date - CURRENT_DATE, NULL) AS days_until_expiry, created_at, updated_at`;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { category } = req.query;

  const params: unknown[] = [companyId];
  let where = 'company_id = $1';
  if (typeof category === 'string') {
    params.push(category);
    where += ` AND category = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM company_files WHERE ${where}
     ORDER BY
       CASE WHEN expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE THEN 0 ELSE 1 END,
       expiry_date ASC NULLS LAST,
       created_at DESC`,
    params
  );
  res.status(200).json({ success: true, files: result.rows });
});

// Full record including file_base64 — kept out of list() to avoid dragging large
// base64 blobs into a table listing, same reasoning as employees.controller.ts's
// SELECT_COLUMNS split (photo/certs are only fetched on the detail view there too).
export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS}, file_base64 FROM company_files WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'File not found');
  res.status(200).json({ success: true, file: result.rows[0] });
});

export const getExpiring = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const days = parseInt(String(req.query.days ?? '30'), 10) || 30;

  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM company_files
     WHERE company_id = $1
       AND expiry_date IS NOT NULL
       AND expiry_date <= CURRENT_DATE + INTERVAL '1 day' * $2
     ORDER BY expiry_date ASC`,
    [companyId, days]
  );
  res.status(200).json({ success: true, files: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { title, category, file_base64, file_name, issue_date, expiry_date, notes } = req.body ?? {};

  if (typeof title !== 'string' || title.trim().length < 1) throw new AppError(400, 'title is required');
  if (category !== undefined && !CATEGORIES.includes(category)) {
    throw new AppError(400, `category must be one of ${CATEGORIES.join(', ')}`);
  }

  const result = await pool.query(
    `INSERT INTO company_files (company_id, title, category, file_base64, file_name, issue_date, expiry_date, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${SELECT_COLUMNS}`,
    [
      companyId,
      title.trim(),
      category ?? 'other',
      file_base64 ?? null,
      file_name ?? null,
      issue_date ?? null,
      expiry_date ?? null,
      notes ?? null,
      req.auth!.userId,
    ]
  );
  const file = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'company_file_created', entityType: 'company_files', entityId: file.id, req });

  res.status(201).json({ success: true, file });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { title, category, file_base64, file_name, issue_date, expiry_date, notes } = req.body ?? {};

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const setField = (column: string, value: unknown) => {
    sets.push(`${column} = $${i++}`);
    values.push(value);
  };

  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim().length < 1) throw new AppError(400, 'title must be a non-empty string');
    setField('title', title.trim());
  }
  if (category !== undefined) {
    if (!CATEGORIES.includes(category)) throw new AppError(400, `category must be one of ${CATEGORIES.join(', ')}`);
    setField('category', category);
  }
  if (file_base64 !== undefined) setField('file_base64', file_base64 || null);
  if (file_name !== undefined) setField('file_name', file_name || null);
  if (issue_date !== undefined) setField('issue_date', issue_date || null);
  if (expiry_date !== undefined) setField('expiry_date', expiry_date || null);
  if (notes !== undefined) setField('notes', notes || null);

  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push('updated_at = NOW()');
  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE company_files SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i}
     RETURNING ${SELECT_COLUMNS}`,
    values
  );
  const file = result.rows[0];
  if (!file) throw new AppError(404, 'File not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'company_file_updated', entityType: 'company_files', entityId: file.id, req });

  res.status(200).json({ success: true, file });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query(`DELETE FROM company_files WHERE id = $1 AND company_id = $2 RETURNING id`, [id, companyId]);
  if (!result.rows[0]) throw new AppError(404, 'File not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'company_file_deleted', entityType: 'company_files', entityId: id as string, req });

  res.status(200).json({ success: true, message: 'File deleted' });
});
