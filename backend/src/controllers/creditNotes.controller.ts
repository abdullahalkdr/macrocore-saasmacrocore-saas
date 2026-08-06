import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

interface ItemInput {
  description: string;
  qty: number;
  unit_price: number;
}

function validateItems(items: unknown): ItemInput[] {
  if (!Array.isArray(items) || items.length === 0) throw new AppError(400, 'items must be a non-empty array');
  for (const it of items) {
    if (typeof it?.description !== 'string' || !it.description.trim()) throw new AppError(400, 'each item needs a description');
    if (typeof it?.qty !== 'number' || it.qty <= 0) throw new AppError(400, 'each item needs a positive qty');
    if (typeof it?.unit_price !== 'number' || it.unit_price < 0) throw new AppError(400, 'each item needs a non-negative unit_price');
  }
  return items;
}

function computeTotals(items: ItemInput[]) {
  const subtotal = items.reduce((sum, it) => sum + it.qty * it.unit_price, 0);
  return { subtotal, total: subtotal };
}

async function nextNumber(companyId: string): Promise<string> {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM sales_credit_notes WHERE company_id = $1', [companyId]);
  return `CN-${String(100 + r.rows[0].n).padStart(6, '0')}`;
}

async function fetchItems(noteId: string) {
  const result = await pool.query(
    `SELECT id, description, qty, unit_price, line_total FROM sales_credit_note_items WHERE credit_note_id = $1 ORDER BY sort_order`,
    [noteId]
  );
  return result.rows;
}

const LIST_SELECT = `
  n.id, n.number, n.customer_id, c.name AS customer_name, n.source_invoice_id, inv.number AS source_invoice_number,
  n.issue_date, n.status, n.notes, n.subtotal, n.total, n.created_at
`;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT ${LIST_SELECT} FROM sales_credit_notes n
     LEFT JOIN customers c ON c.id = n.customer_id
     LEFT JOIN sales_invoices inv ON inv.id = n.source_invoice_id
     WHERE n.company_id = $1 ORDER BY n.created_at DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, credit_notes: result.rows });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const result = await pool.query(
    `SELECT ${LIST_SELECT} FROM sales_credit_notes n
     LEFT JOIN customers c ON c.id = n.customer_id
     LEFT JOIN sales_invoices inv ON inv.id = n.source_invoice_id
     WHERE n.id = $1 AND n.company_id = $2`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Credit note not found');
  const items = await fetchItems(id as string);
  res.status(200).json({ success: true, credit_note: result.rows[0], items });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { customer_id, source_invoice_id, issue_date, notes, items } = req.body ?? {};

  const itemList = validateItems(items);
  const { subtotal, total } = computeTotals(itemList);

  if (customer_id) {
    const c = await pool.query('SELECT id FROM customers WHERE id = $1 AND company_id = $2', [customer_id, companyId]);
    if (c.rows.length === 0) throw new AppError(400, 'customer_id not found');
  }
  if (source_invoice_id) {
    const inv = await pool.query('SELECT id FROM sales_invoices WHERE id = $1 AND company_id = $2', [source_invoice_id, companyId]);
    if (inv.rows.length === 0) throw new AppError(400, 'source_invoice_id not found');
  }

  const number = await nextNumber(companyId);

  const client = await pool.connect();
  let noteId: string;
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO sales_credit_notes (company_id, number, customer_id, source_invoice_id, issue_date, notes, subtotal, total, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [companyId, number, customer_id ?? null, source_invoice_id ?? null, issue_date || new Date().toISOString().slice(0, 10), notes ?? null, subtotal, total, req.auth!.userId]
    );
    noteId = r.rows[0].id;
    for (let idx = 0; idx < itemList.length; idx++) {
      const it = itemList[idx];
      await client.query(
        `INSERT INTO sales_credit_note_items (credit_note_id, description, qty, unit_price, line_total, sort_order) VALUES ($1, $2, $3, $4, $5, $6)`,
        [noteId, it.description.trim(), it.qty, it.unit_price, it.qty * it.unit_price, idx]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'credit_note_created', entityType: 'sales_credit_notes', entityId: noteId, req });

  res.status(201).json({ success: true, credit_note: { id: noteId, number } });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { customer_id, source_invoice_id, issue_date, notes, items, status } = req.body ?? {};

  const existing = await pool.query('SELECT status FROM sales_credit_notes WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Credit note not found');
  const currentStatus = existing.rows[0].status;

  if (status !== undefined) {
    if (currentStatus !== 'draft' || status !== 'issued') throw new AppError(400, `Cannot move a ${currentStatus} credit note to ${status}`);
  } else if (currentStatus !== 'draft') {
    throw new AppError(400, 'Only draft credit notes can be edited');
  }

  if (customer_id !== undefined && customer_id) {
    const c = await pool.query('SELECT id FROM customers WHERE id = $1 AND company_id = $2', [customer_id, companyId]);
    if (c.rows.length === 0) throw new AppError(400, 'customer_id not found');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let subtotal: number | undefined;
    let total: number | undefined;
    let itemList: ItemInput[] | undefined;
    if (items !== undefined) {
      itemList = validateItems(items);
      ({ subtotal, total } = computeTotals(itemList));
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const set = (col: string, val: unknown) => {
      sets.push(`${col} = $${i++}`);
      values.push(val);
    };
    if (customer_id !== undefined) set('customer_id', customer_id || null);
    if (source_invoice_id !== undefined) set('source_invoice_id', source_invoice_id || null);
    if (issue_date !== undefined) set('issue_date', issue_date || null);
    if (notes !== undefined) set('notes', notes || null);
    if (status !== undefined) set('status', status);
    if (subtotal !== undefined) {
      set('subtotal', subtotal);
      set('total', total);
    }
    if (sets.length > 0) {
      sets.push('updated_at = NOW()');
      values.push(id, companyId);
      await client.query(`UPDATE sales_credit_notes SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++}`, values);
    }

    if (itemList) {
      await client.query('DELETE FROM sales_credit_note_items WHERE credit_note_id = $1', [id]);
      for (let idx = 0; idx < itemList.length; idx++) {
        const it = itemList[idx];
        await client.query(
          `INSERT INTO sales_credit_note_items (credit_note_id, description, qty, unit_price, line_total, sort_order) VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, it.description.trim(), it.qty, it.unit_price, it.qty * it.unit_price, idx]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'credit_note_updated', entityType: 'sales_credit_notes', entityId: id as string, req });

  const full = await pool.query(
    `SELECT ${LIST_SELECT} FROM sales_credit_notes n
     LEFT JOIN customers c ON c.id = n.customer_id
     LEFT JOIN sales_invoices inv ON inv.id = n.source_invoice_id
     WHERE n.id = $1`,
    [id]
  );
  const items2 = await fetchItems(id as string);
  res.status(200).json({ success: true, credit_note: full.rows[0], items: items2 });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const existing = await pool.query('SELECT status FROM sales_credit_notes WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Credit note not found');
  if (existing.rows[0].status !== 'draft') throw new AppError(400, 'Only draft credit notes can be deleted');

  await pool.query('DELETE FROM sales_credit_notes WHERE id = $1 AND company_id = $2', [id, companyId]);

  await logAudit({ companyId, userId: req.auth!.userId, action: 'credit_note_deleted', entityType: 'sales_credit_notes', entityId: id as string, req });

  res.status(200).json({ success: true });
});
