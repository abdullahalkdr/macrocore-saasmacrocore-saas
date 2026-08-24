import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { nextReferenceNumber } from '../utils/officialDocuments';

const DOC_TYPES = ['letter', 'salary_certificate', 'experience_certificate', 'receipt', 'other'];

const SELECT_COLUMNS = `od.id, od.reference_number, od.doc_type, od.title, od.document_date, od.body,
  od.addressed_to_employee_id, od.addressed_to_name, e.name AS addressed_to_employee_name,
  od.created_at, od.updated_at`;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS}
     FROM official_documents od
     LEFT JOIN employees e ON e.id = od.addressed_to_employee_id AND e.company_id = od.company_id
     WHERE od.company_id = $1
     ORDER BY od.created_at DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, documents: result.rows });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS}
     FROM official_documents od
     LEFT JOIN employees e ON e.id = od.addressed_to_employee_id AND e.company_id = od.company_id
     WHERE od.id = $1 AND od.company_id = $2`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Document not found');
  res.status(200).json({ success: true, document: result.rows[0] });
});

// Peek at the next reference number without creating a document — lets the "new
// document" form show it upfront (see screenshot: the field is visible before Save).
export const peekNextReference = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const year = new Date().getFullYear();
  const client = await pool.connect();
  try {
    const referenceNumber = await nextReferenceNumber(client, companyId, year);
    res.status(200).json({ success: true, reference_number: referenceNumber });
  } finally {
    client.release();
  }
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { doc_type, title, addressed_to_employee_id, addressed_to_name, document_date, body } = req.body ?? {};

  if (!DOC_TYPES.includes(doc_type)) throw new AppError(400, `doc_type must be one of ${DOC_TYPES.join(', ')}`);
  if (typeof title !== 'string' || title.trim().length < 1) throw new AppError(400, 'title is required');
  if (typeof document_date !== 'string') throw new AppError(400, 'document_date is required (YYYY-MM-DD)');
  if (addressed_to_employee_id === undefined && !addressed_to_name) {
    throw new AppError(400, 'either addressed_to_employee_id or addressed_to_name is required');
  }

  if (addressed_to_employee_id) {
    const emp = await pool.query(`SELECT id FROM employees WHERE id = $1 AND company_id = $2`, [addressed_to_employee_id, companyId]);
    if (!emp.rows[0]) throw new AppError(404, 'addressed_to_employee_id not found');
  }

  const year = new Date(document_date).getFullYear() || new Date().getFullYear();

  const client = await pool.connect();
  let document;
  try {
    await client.query('BEGIN');

    const referenceNumber = await nextReferenceNumber(client, companyId, year);

    const result = await client.query(
      `INSERT INTO official_documents (company_id, reference_number, doc_type, title, addressed_to_employee_id, addressed_to_name, document_date, body, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, reference_number, doc_type, title, addressed_to_employee_id, addressed_to_name, document_date, body, created_at`,
      [
        companyId,
        referenceNumber,
        doc_type,
        title.trim(),
        addressed_to_employee_id || null,
        addressed_to_employee_id ? null : addressed_to_name?.trim() || null,
        document_date,
        body ?? null,
        req.auth!.userId,
      ]
    );
    document = result.rows[0];

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'official_document_created', entityType: 'official_documents', entityId: document.id, req });

  res.status(201).json({ success: true, document });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { doc_type, title, addressed_to_employee_id, addressed_to_name, document_date, body } = req.body ?? {};

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const setField = (column: string, value: unknown) => {
    sets.push(`${column} = $${i++}`);
    values.push(value);
  };

  if (doc_type !== undefined) {
    if (!DOC_TYPES.includes(doc_type)) throw new AppError(400, `doc_type must be one of ${DOC_TYPES.join(', ')}`);
    setField('doc_type', doc_type);
  }
  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim().length < 1) throw new AppError(400, 'title must be a non-empty string');
    setField('title', title.trim());
  }
  if (addressed_to_employee_id !== undefined) {
    if (addressed_to_employee_id) {
      const emp = await pool.query(`SELECT id FROM employees WHERE id = $1 AND company_id = $2`, [addressed_to_employee_id, companyId]);
      if (!emp.rows[0]) throw new AppError(404, 'addressed_to_employee_id not found');
    }
    setField('addressed_to_employee_id', addressed_to_employee_id || null);
    // Picking an employee clears the free-text name, and vice versa — the two are mutually exclusive.
    setField('addressed_to_name', addressed_to_employee_id ? null : addressed_to_name?.trim() || null);
  } else if (addressed_to_name !== undefined) {
    setField('addressed_to_name', addressed_to_name?.trim() || null);
    setField('addressed_to_employee_id', null);
  }
  if (document_date !== undefined) {
    if (typeof document_date !== 'string') throw new AppError(400, 'document_date must be a string (YYYY-MM-DD)');
    setField('document_date', document_date);
  }
  if (body !== undefined) setField('body', body || null);

  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push('updated_at = NOW()');
  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE official_documents SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i}
     RETURNING id, reference_number, doc_type, title, addressed_to_employee_id, addressed_to_name, document_date, body, updated_at`,
    values
  );
  const document = result.rows[0];
  if (!document) throw new AppError(404, 'Document not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'official_document_updated', entityType: 'official_documents', entityId: document.id, req });

  res.status(200).json({ success: true, document });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query(`DELETE FROM official_documents WHERE id = $1 AND company_id = $2 RETURNING id`, [id, companyId]);
  if (!result.rows[0]) throw new AppError(404, 'Document not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'official_document_deleted', entityType: 'official_documents', entityId: id as string, req });

  res.status(200).json({ success: true, message: 'Document deleted' });
});
