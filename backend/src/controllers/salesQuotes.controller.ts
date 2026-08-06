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
  // No tax anywhere in macrocore (Kuwait has no VAT) — total is always == subtotal.
  // Kept as a separate column (rather than deriving it in every query) so a future
  // discount/rounding feature has somewhere to land without a schema change.
  return { subtotal, total: subtotal };
}

async function nextNumber(companyId: string): Promise<string> {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM sales_quotes WHERE company_id = $1', [companyId]);
  return `QUO-${String(100 + r.rows[0].n).padStart(6, '0')}`;
}

async function fetchItems(quoteId: string) {
  const result = await pool.query(
    `SELECT id, description, qty, unit_price, line_total FROM sales_quote_items WHERE quote_id = $1 ORDER BY sort_order`,
    [quoteId]
  );
  return result.rows;
}

const LIST_SELECT = `
  q.id, q.number, q.customer_id, c.name AS customer_name, q.issue_date, q.status,
  q.notes, q.subtotal, q.total, q.created_at
`;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { status } = req.query;

  const params: unknown[] = [companyId];
  let where = 'q.company_id = $1';
  if (typeof status === 'string' && status) {
    params.push(status);
    where += ` AND q.status = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT ${LIST_SELECT} FROM sales_quotes q LEFT JOIN customers c ON c.id = q.customer_id
     WHERE ${where} ORDER BY q.created_at DESC`,
    params
  );
  res.status(200).json({ success: true, quotes: result.rows });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query(
    `SELECT ${LIST_SELECT} FROM sales_quotes q LEFT JOIN customers c ON c.id = q.customer_id
     WHERE q.id = $1 AND q.company_id = $2`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Quote not found');

  const items = await fetchItems(id as string);
  res.status(200).json({ success: true, quote: result.rows[0], items });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { customer_id, issue_date, notes, items } = req.body ?? {};

  const itemList = validateItems(items);
  const { subtotal, total } = computeTotals(itemList);

  if (customer_id) {
    const c = await pool.query('SELECT id FROM customers WHERE id = $1 AND company_id = $2', [customer_id, companyId]);
    if (c.rows.length === 0) throw new AppError(400, 'customer_id not found');
  }

  const number = await nextNumber(companyId);

  const client = await pool.connect();
  let quoteId: string;
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO sales_quotes (company_id, number, customer_id, issue_date, notes, subtotal, total, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [companyId, number, customer_id ?? null, issue_date || new Date().toISOString().slice(0, 10), notes ?? null, subtotal, total, req.auth!.userId]
    );
    quoteId = r.rows[0].id;

    for (let idx = 0; idx < itemList.length; idx++) {
      const it = itemList[idx];
      await client.query(
        `INSERT INTO sales_quote_items (quote_id, description, qty, unit_price, line_total, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [quoteId, it.description.trim(), it.qty, it.unit_price, it.qty * it.unit_price, idx]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'sales_quote_created', entityType: 'sales_quotes', entityId: quoteId, req });

  res.status(201).json({ success: true, quote: { id: quoteId, number } });
});

// Draft-only editing, same spirit as purchase orders: once sent/accepted/declined, the
// document is locked — create a new one instead of rewriting history.
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { customer_id, issue_date, notes, items, status } = req.body ?? {};

  const existing = await pool.query('SELECT status FROM sales_quotes WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Quote not found');
  const currentStatus = existing.rows[0].status;

  if (status !== undefined) {
    const allowed: Record<string, string[]> = { draft: ['sent'], sent: ['accepted', 'declined'] };
    if (!allowed[currentStatus]?.includes(status)) {
      throw new AppError(400, `Cannot move a ${currentStatus} quote to ${status}`);
    }
  } else if (currentStatus !== 'draft') {
    throw new AppError(400, 'Only draft quotes can be edited — this one has already been sent');
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
      await client.query(`UPDATE sales_quotes SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++}`, values);
    }

    if (itemList) {
      await client.query('DELETE FROM sales_quote_items WHERE quote_id = $1', [id]);
      for (let idx = 0; idx < itemList.length; idx++) {
        const it = itemList[idx];
        await client.query(
          `INSERT INTO sales_quote_items (quote_id, description, qty, unit_price, line_total, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
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

  await logAudit({ companyId, userId: req.auth!.userId, action: 'sales_quote_updated', entityType: 'sales_quotes', entityId: id as string, req });

  const full = await pool.query(
    `SELECT ${LIST_SELECT} FROM sales_quotes q LEFT JOIN customers c ON c.id = q.customer_id WHERE q.id = $1`,
    [id]
  );
  const items2 = await fetchItems(id as string);
  res.status(200).json({ success: true, quote: full.rows[0], items: items2 });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const existing = await pool.query('SELECT status FROM sales_quotes WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Quote not found');
  if (existing.rows[0].status !== 'draft') {
    throw new AppError(400, 'Only draft quotes can be deleted');
  }

  await pool.query('DELETE FROM sales_quotes WHERE id = $1 AND company_id = $2', [id, companyId]);

  await logAudit({ companyId, userId: req.auth!.userId, action: 'sales_quote_deleted', entityType: 'sales_quotes', entityId: id as string, req });

  res.status(200).json({ success: true });
});
