import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

const METHODS = ['cash', 'bank_transfer', 'card', 'knet', 'cheque', 'other'] as const;

const LIST_SELECT = `
  r.id, r.customer_id, c.name AS customer_name, r.invoice_id, i.number AS invoice_number,
  r.amount, r.receipt_date, r.method, r.notes, r.created_at
`;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT ${LIST_SELECT} FROM customer_receipts r
     LEFT JOIN customers c ON c.id = r.customer_id
     LEFT JOIN sales_invoices i ON i.id = r.invoice_id
     WHERE r.company_id = $1 ORDER BY r.receipt_date DESC, r.created_at DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, receipts: result.rows });
});

// Invoices that still make sense to receive a payment against, for a given customer —
// used to populate the "apply to invoice" dropdown when writing a receipt.
export const openInvoicesForCustomer = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { customerId } = req.params;
  const result = await pool.query(
    `SELECT id, number, total, amount_paid FROM sales_invoices
     WHERE company_id = $1 AND customer_id = $2 AND status IN ('sent', 'overdue') AND amount_paid < total
     ORDER BY issue_date`,
    [companyId, customerId]
  );
  res.status(200).json({ success: true, invoices: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { customer_id, invoice_id, amount, receipt_date, method, notes } = req.body ?? {};

  if (typeof amount !== 'number' || amount <= 0) throw new AppError(400, 'amount must be a positive number');
  const methodValue = METHODS.includes(method) ? method : 'cash';

  if (customer_id) {
    const c = await pool.query('SELECT id FROM customers WHERE id = $1 AND company_id = $2', [customer_id, companyId]);
    if (c.rows.length === 0) throw new AppError(400, 'customer_id not found');
  }

  const client = await pool.connect();
  let receiptId: string;
  try {
    await client.query('BEGIN');

    if (invoice_id) {
      const inv = await client.query(
        `SELECT total, amount_paid, status FROM sales_invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [invoice_id, companyId]
      );
      if (!inv.rows[0]) throw new AppError(400, 'invoice_id not found');
      const newPaid = Math.min(Number(inv.rows[0].total), Number(inv.rows[0].amount_paid) + amount);
      const newStatus = newPaid >= Number(inv.rows[0].total) ? 'paid' : inv.rows[0].status;
      await client.query(
        `UPDATE sales_invoices SET amount_paid = $1, status = $2, updated_at = NOW() WHERE id = $3`,
        [newPaid, newStatus, invoice_id]
      );
    }

    const r = await client.query(
      `INSERT INTO customer_receipts (company_id, customer_id, invoice_id, amount, receipt_date, method, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [companyId, customer_id ?? null, invoice_id ?? null, amount, receipt_date || new Date().toISOString().slice(0, 10), methodValue, notes ?? null, req.auth!.userId]
    );
    receiptId = r.rows[0].id;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'customer_receipt_created', entityType: 'customer_receipts', entityId: receiptId, req });

  res.status(201).json({ success: true, receipt: { id: receiptId } });
});

// No update endpoint on purpose — a receipt that was applied to an invoice already
// nudged that invoice's amount_paid; editing the amount after the fact would need to
// re-derive that adjustment. Delete-and-recreate is simpler and safer at this scale.
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT invoice_id, amount FROM customer_receipts WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [id, companyId]
    );
    if (!existing.rows[0]) throw new AppError(404, 'Receipt not found');

    if (existing.rows[0].invoice_id) {
      const inv = await client.query('SELECT total, amount_paid FROM sales_invoices WHERE id = $1 FOR UPDATE', [existing.rows[0].invoice_id]);
      if (inv.rows[0]) {
        const newPaid = Math.max(0, Number(inv.rows[0].amount_paid) - Number(existing.rows[0].amount));
        const newStatus = newPaid < Number(inv.rows[0].total) ? 'sent' : 'paid';
        await client.query('UPDATE sales_invoices SET amount_paid = $1, status = $2, updated_at = NOW() WHERE id = $3', [
          newPaid,
          newStatus,
          existing.rows[0].invoice_id,
        ]);
      }
    }

    await client.query('DELETE FROM customer_receipts WHERE id = $1 AND company_id = $2', [id, companyId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'customer_receipt_deleted', entityType: 'customer_receipts', entityId: id as string, req });

  res.status(200).json({ success: true });
});
