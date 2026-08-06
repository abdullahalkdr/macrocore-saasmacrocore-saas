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

async function fetchItems(templateId: string) {
  const r = await pool.query(
    `SELECT id, description, qty, unit_price FROM recurring_invoice_items WHERE template_id = $1 ORDER BY sort_order`,
    [templateId]
  );
  return r.rows;
}

function advance(date: string, frequency: 'weekly' | 'monthly'): string {
  const d = new Date(date);
  if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

const LIST_SELECT = `
  t.id, t.customer_id, c.name AS customer_name, t.frequency, t.next_run_date, t.active, t.notes, t.created_at
`;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT ${LIST_SELECT} FROM recurring_invoice_templates t LEFT JOIN customers c ON c.id = t.customer_id
     WHERE t.company_id = $1 ORDER BY t.created_at DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, templates: result.rows });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const result = await pool.query(
    `SELECT ${LIST_SELECT} FROM recurring_invoice_templates t LEFT JOIN customers c ON c.id = t.customer_id
     WHERE t.id = $1 AND t.company_id = $2`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Template not found');
  const items = await fetchItems(id as string);
  res.status(200).json({ success: true, template: result.rows[0], items });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { customer_id, frequency, next_run_date, notes, items } = req.body ?? {};

  const itemList = validateItems(items);
  const freq = frequency === 'weekly' ? 'weekly' : 'monthly';

  if (customer_id) {
    const c = await pool.query('SELECT id FROM customers WHERE id = $1 AND company_id = $2', [customer_id, companyId]);
    if (c.rows.length === 0) throw new AppError(400, 'customer_id not found');
  }

  const client = await pool.connect();
  let templateId: string;
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO recurring_invoice_templates (company_id, customer_id, frequency, next_run_date, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [companyId, customer_id ?? null, freq, next_run_date || new Date().toISOString().slice(0, 10), notes ?? null, req.auth!.userId]
    );
    templateId = r.rows[0].id;
    for (let idx = 0; idx < itemList.length; idx++) {
      const it = itemList[idx];
      await client.query(
        `INSERT INTO recurring_invoice_items (template_id, description, qty, unit_price, sort_order) VALUES ($1, $2, $3, $4, $5)`,
        [templateId, it.description.trim(), it.qty, it.unit_price, idx]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'recurring_invoice_template_created', entityType: 'recurring_invoice_templates', entityId: templateId, req });

  res.status(201).json({ success: true, template: { id: templateId } });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { customer_id, frequency, next_run_date, notes, items, active } = req.body ?? {};

  const existing = await pool.query('SELECT id FROM recurring_invoice_templates WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Template not found');

  if (customer_id !== undefined && customer_id) {
    const c = await pool.query('SELECT id FROM customers WHERE id = $1 AND company_id = $2', [customer_id, companyId]);
    if (c.rows.length === 0) throw new AppError(400, 'customer_id not found');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const set = (col: string, val: unknown) => {
      sets.push(`${col} = $${i++}`);
      values.push(val);
    };
    if (customer_id !== undefined) set('customer_id', customer_id || null);
    if (frequency !== undefined) set('frequency', frequency === 'weekly' ? 'weekly' : 'monthly');
    if (next_run_date !== undefined) set('next_run_date', next_run_date || null);
    if (notes !== undefined) set('notes', notes || null);
    if (active !== undefined) set('active', !!active);
    if (sets.length > 0) {
      sets.push('updated_at = NOW()');
      values.push(id, companyId);
      await client.query(`UPDATE recurring_invoice_templates SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++}`, values);
    }

    if (items !== undefined) {
      const itemList = validateItems(items);
      await client.query('DELETE FROM recurring_invoice_items WHERE template_id = $1', [id]);
      for (let idx = 0; idx < itemList.length; idx++) {
        const it = itemList[idx];
        await client.query(
          `INSERT INTO recurring_invoice_items (template_id, description, qty, unit_price, sort_order) VALUES ($1, $2, $3, $4, $5)`,
          [id, it.description.trim(), it.qty, it.unit_price, idx]
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

  await logAudit({ companyId, userId: req.auth!.userId, action: 'recurring_invoice_template_updated', entityType: 'recurring_invoice_templates', entityId: id as string, req });

  const full = await pool.query(
    `SELECT ${LIST_SELECT} FROM recurring_invoice_templates t LEFT JOIN customers c ON c.id = t.customer_id WHERE t.id = $1`,
    [id]
  );
  const items2 = await fetchItems(id as string);
  res.status(200).json({ success: true, template: full.rows[0], items: items2 });
});

// Manually fires the template: creates one real sales_invoices row (status 'draft',
// same as any other invoice — still goes through the normal send/paid workflow) and
// advances next_run_date by one period. No automatic cron here (see migration
// comment) — this is triggered from the "Generate now" button on the page.
export const generateNow = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const tmpl = await pool.query('SELECT customer_id, frequency, next_run_date, notes FROM recurring_invoice_templates WHERE id = $1 AND company_id = $2', [
    id,
    companyId,
  ]);
  if (!tmpl.rows[0]) throw new AppError(404, 'Template not found');
  const items = await fetchItems(id as string);
  if (items.length === 0) throw new AppError(400, 'Template has no items');

  const subtotal = items.reduce((sum, it) => sum + Number(it.qty) * Number(it.unit_price), 0);
  const countResult = await pool.query('SELECT COUNT(*)::int AS n FROM sales_invoices WHERE company_id = $1', [companyId]);
  const number = `INV-${String(100 + countResult.rows[0].n).padStart(6, '0')}`;

  const client = await pool.connect();
  let invoiceId: string;
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO sales_invoices (company_id, number, customer_id, issue_date, notes, subtotal, total, created_by)
       VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $5, $6) RETURNING id`,
      [companyId, number, tmpl.rows[0].customer_id, tmpl.rows[0].notes, subtotal, req.auth!.userId]
    );
    invoiceId = r.rows[0].id;
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      await client.query(
        `INSERT INTO sales_invoice_items (invoice_id, description, qty, unit_price, line_total, sort_order) VALUES ($1, $2, $3, $4, $5, $6)`,
        [invoiceId, it.description, it.qty, it.unit_price, Number(it.qty) * Number(it.unit_price), idx]
      );
    }
    await client.query(
      `UPDATE recurring_invoice_templates SET next_run_date = $1, updated_at = NOW() WHERE id = $2`,
      [advance(tmpl.rows[0].next_run_date.toISOString().slice(0, 10), tmpl.rows[0].frequency), id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'recurring_invoice_generated', entityType: 'sales_invoices', entityId: invoiceId, req });

  res.status(201).json({ success: true, invoice: { id: invoiceId, number } });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const result = await pool.query('DELETE FROM recurring_invoice_templates WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (!result.rows[0]) throw new AppError(404, 'Template not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'recurring_invoice_template_deleted', entityType: 'recurring_invoice_templates', entityId: id as string, req });

  res.status(200).json({ success: true });
});
