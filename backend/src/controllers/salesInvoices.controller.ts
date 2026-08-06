import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

interface ItemInput {
  description: string;
  qty: number;
  unit_price: number;
  discount_pct: number;
}

function validateItems(items: unknown): ItemInput[] {
  if (!Array.isArray(items) || items.length === 0) throw new AppError(400, 'items must be a non-empty array');
  for (const it of items) {
    if (typeof it?.description !== 'string' || !it.description.trim()) throw new AppError(400, 'each item needs a description');
    if (typeof it?.qty !== 'number' || it.qty <= 0) throw new AppError(400, 'each item needs a positive qty');
    if (typeof it?.unit_price !== 'number' || it.unit_price < 0) throw new AppError(400, 'each item needs a non-negative unit_price');
    if (it.discount_pct !== undefined && (typeof it.discount_pct !== 'number' || it.discount_pct < 0 || it.discount_pct > 100)) {
      throw new AppError(400, 'discount_pct must be between 0 and 100');
    }
    it.discount_pct = it.discount_pct ?? 0;
  }
  return items;
}

function lineTotal(it: ItemInput) {
  return it.qty * it.unit_price * (1 - it.discount_pct / 100);
}

function computeTotals(items: ItemInput[]) {
  // subtotal = gross (before discount), total = net (after each line's discount_pct).
  // No tax anywhere in macrocore (Kuwait has no VAT) — nothing else adjusts total.
  const subtotal = items.reduce((sum, it) => sum + it.qty * it.unit_price, 0);
  const total = items.reduce((sum, it) => sum + lineTotal(it), 0);
  return { subtotal, total };
}

async function nextNumber(companyId: string, type: 'invoice' | 'cash'): Promise<string> {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM sales_invoices WHERE company_id = $1 AND type = $2', [companyId, type]);
  const prefix = type === 'cash' ? 'CINV' : 'INV';
  return `${prefix}-${String(100 + r.rows[0].n).padStart(6, '0')}`;
}

async function fetchItems(invoiceId: string) {
  const result = await pool.query(
    `SELECT id, description, qty, unit_price, discount_pct, line_total FROM sales_invoice_items WHERE invoice_id = $1 ORDER BY sort_order`,
    [invoiceId]
  );
  return result.rows;
}

const LIST_SELECT = `
  i.id, i.number, i.type, i.customer_id, c.name AS customer_name, i.issue_date, i.due_date, i.status,
  i.notes, i.subtotal, i.total, i.amount_paid, i.created_at
`;

// type defaults to 'invoice' so the regular Sales Invoices page never shows cash
// invoices mixed in — the Cash Invoices page passes ?type=cash explicitly instead.
export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { status, type } = req.query;

  const params: unknown[] = [companyId];
  let where = 'i.company_id = $1';
  params.push(type === 'cash' ? 'cash' : 'invoice');
  where += ` AND i.type = $${params.length}`;
  if (typeof status === 'string' && status) {
    params.push(status);
    where += ` AND i.status = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT ${LIST_SELECT} FROM sales_invoices i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE ${where} ORDER BY i.created_at DESC`,
    params
  );
  res.status(200).json({ success: true, invoices: result.rows });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query(
    `SELECT ${LIST_SELECT} FROM sales_invoices i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.id = $1 AND i.company_id = $2`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Invoice not found');

  const items = await fetchItems(id as string);
  res.status(200).json({ success: true, invoice: result.rows[0], items });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { customer_id, issue_date, due_date, notes, items, type, status } = req.body ?? {};

  const itemList = validateItems(items);
  const { subtotal, total } = computeTotals(itemList);
  const docType: 'invoice' | 'cash' = type === 'cash' ? 'cash' : 'invoice';
  // A cash invoice skips the sent/overdue steps a real invoice goes through, but per
  // Abdullah's Wafeq reference it still has two buttons at creation: "حفظ كمسودة"
  // (save as draft — nothing collected yet, e.g. writing it up before the customer
  // pays) and "اعتماد" (confirm — money collected right now, marks it paid in full
  // immediately). Regular invoices always start as draft regardless of what's sent
  // here; only cash invoices honor an explicit draft request.
  const isCash = docType === 'cash';
  const cashConfirmed = isCash && status !== 'draft';

  if (customer_id) {
    const c = await pool.query('SELECT id FROM customers WHERE id = $1 AND company_id = $2', [customer_id, companyId]);
    if (c.rows.length === 0) throw new AppError(400, 'customer_id not found');
  }

  const number = await nextNumber(companyId, docType);

  const client = await pool.connect();
  let invoiceId: string;
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO sales_invoices (company_id, number, type, customer_id, issue_date, due_date, notes, subtotal, total, status, amount_paid, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        companyId,
        number,
        docType,
        customer_id ?? null,
        issue_date || new Date().toISOString().slice(0, 10),
        isCash ? null : due_date || null,
        notes ?? null,
        subtotal,
        total,
        isCash ? (cashConfirmed ? 'paid' : 'draft') : 'draft',
        isCash && cashConfirmed ? total : 0,
        req.auth!.userId,
      ]
    );
    invoiceId = r.rows[0].id;

    for (let idx = 0; idx < itemList.length; idx++) {
      const it = itemList[idx];
      await client.query(
        `INSERT INTO sales_invoice_items (invoice_id, description, qty, unit_price, discount_pct, line_total, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [invoiceId, it.description.trim(), it.qty, it.unit_price, it.discount_pct, lineTotal(it), idx]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'sales_invoice_created', entityType: 'sales_invoices', entityId: invoiceId, req });

  res.status(201).json({ success: true, invoice: { id: invoiceId, number } });
});

// Draft-only editing for scalar fields + items. status can additionally move forward
// (draft -> sent -> paid/overdue -> ... ) at any time via this same endpoint — sending
// or marking paid doesn't require the document to still be a draft.
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { customer_id, issue_date, due_date, notes, items, status, amount_paid } = req.body ?? {};

  const existing = await pool.query('SELECT status, type, total FROM sales_invoices WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Invoice not found');
  const currentStatus = existing.rows[0].status;
  const invoiceType = existing.rows[0].type as 'invoice' | 'cash';
  const existingTotal = Number(existing.rows[0].total);

  if (status !== undefined) {
    // Cash invoices skip sent/overdue entirely — a draft cash invoice just needs
    // "اعتماد" (confirm payment received) or cancellation.
    const allowed: Record<string, string[]> =
      invoiceType === 'cash'
        ? { draft: ['paid', 'cancelled'] }
        : {
            draft: ['sent', 'cancelled'],
            sent: ['paid', 'overdue', 'cancelled'],
            overdue: ['paid', 'cancelled'],
          };
    if (!allowed[currentStatus]?.includes(status)) {
      throw new AppError(400, `Cannot move a ${currentStatus} invoice to ${status}`);
    }
  }
  if ((items !== undefined || customer_id !== undefined) && currentStatus !== 'draft') {
    throw new AppError(400, 'Only draft invoices can have their details edited — this one has already been sent');
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
    if (due_date !== undefined) set('due_date', due_date || null);
    if (notes !== undefined) set('notes', notes || null);
    if (status !== undefined) set('status', status);
    if (amount_paid !== undefined) {
      if (typeof amount_paid !== 'number' || amount_paid < 0) throw new AppError(400, 'amount_paid must be a non-negative number');
      set('amount_paid', amount_paid);
    } else if (status === 'paid' && invoiceType === 'cash') {
      // "اعتماد" on a draft cash invoice confirms full payment — auto-fill amount_paid
      // with the (possibly just-edited) total so the frontend doesn't have to send it.
      set('amount_paid', total !== undefined ? total : existingTotal);
    }
    if (subtotal !== undefined) {
      set('subtotal', subtotal);
      set('total', total);
    }
    if (sets.length > 0) {
      sets.push('updated_at = NOW()');
      values.push(id, companyId);
      await client.query(`UPDATE sales_invoices SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++}`, values);
    }

    if (itemList) {
      await client.query('DELETE FROM sales_invoice_items WHERE invoice_id = $1', [id]);
      for (let idx = 0; idx < itemList.length; idx++) {
        const it = itemList[idx];
        await client.query(
          `INSERT INTO sales_invoice_items (invoice_id, description, qty, unit_price, discount_pct, line_total, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, it.description.trim(), it.qty, it.unit_price, it.discount_pct, lineTotal(it), idx]
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

  await logAudit({ companyId, userId: req.auth!.userId, action: 'sales_invoice_updated', entityType: 'sales_invoices', entityId: id as string, req });

  const full = await pool.query(
    `SELECT ${LIST_SELECT} FROM sales_invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = $1`,
    [id]
  );
  const items2 = await fetchItems(id as string);
  res.status(200).json({ success: true, invoice: full.rows[0], items: items2 });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const existing = await pool.query('SELECT status FROM sales_invoices WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Invoice not found');
  if (existing.rows[0].status !== 'draft') {
    throw new AppError(400, 'Only draft invoices can be deleted');
  }

  await pool.query('DELETE FROM sales_invoices WHERE id = $1 AND company_id = $2', [id, companyId]);

  await logAudit({ companyId, userId: req.auth!.userId, action: 'sales_invoice_deleted', entityType: 'sales_invoices', entityId: id as string, req });

  res.status(200).json({ success: true });
});
