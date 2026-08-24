import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { isCompanyGoldPlus, getLatestApproval, fileApprovalRequest } from '../utils/financialApprovals';

interface ItemInput {
  raw_material_id: string;
  qty: number;
  unit_price: number;
}

function validateItems(items: unknown): ItemInput[] {
  if (!Array.isArray(items) || items.length === 0) throw new AppError(400, 'items must be a non-empty array');
  for (const it of items) {
    if (typeof it?.raw_material_id !== 'string') throw new AppError(400, 'each item needs raw_material_id');
    if (typeof it?.qty !== 'number' || it.qty <= 0) throw new AppError(400, 'each item needs a positive qty');
    if (typeof it?.unit_price !== 'number' || it.unit_price < 0) throw new AppError(400, 'each item needs a non-negative unit_price');
  }
  return items;
}

// Security fix (tenant-isolation audit, finding C2): raw_material_id used to go
// straight into purchase_order_items with only the FK-existence constraint backing it
// (raw_materials.id is a global PK, not compound with company_id) — a cross-tenant
// raw_material_id inserted successfully instead of throwing. One batched query for the
// whole item list rather than one row at a time, since a PO can carry many items.
async function assertRawMaterialsInCompany(rawMaterialIds: string[], companyId: string) {
  const uniqueIds = [...new Set(rawMaterialIds)];
  if (uniqueIds.length === 0) return;
  const result = await pool.query(
    `SELECT id FROM raw_materials WHERE id = ANY($1::uuid[]) AND company_id = $2`,
    [uniqueIds, companyId]
  );
  if (result.rows.length !== uniqueIds.length) {
    throw new AppError(400, 'One or more items reference a raw_material_id that does not belong to this company');
  }
}

async function fetchItems(poId: string, companyId: string) {
  const result = await pool.query(
    `SELECT poi.id, poi.raw_material_id, rm.name AS raw_material_name, rm.name_en AS raw_material_name_en,
            poi.qty, poi.unit_price
     FROM purchase_order_items poi
     JOIN raw_materials rm ON rm.id = poi.raw_material_id AND rm.company_id = $2
     WHERE poi.purchase_order_id = $1`,
    [poId, companyId]
  );
  return result.rows;
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { status } = req.query;

  const params: unknown[] = [companyId];
  let where = 'po.company_id = $1';
  if (typeof status === 'string' && status) {
    params.push(status);
    where += ` AND po.status = $${params.length}`;
  }

  // MIGRATION_058 — approval_status resolved live from the latest approval_requests
  // row for this PO (module_type = 'PURCHASE_ORDER'), null for one never submitted
  // (below-Gold company, or a draft that hasn't hit "Send to Supplier" yet). Drives
  // PurchaseOrdersPage.tsx's "Pending approval" badge and disables its actions.
  const result = await pool.query(
    `SELECT po.id, po.supplier_id, s.name AS supplier_name, po.status, po.order_date, po.expected_date,
            po.received_date, po.location_id, l.name AS location_name, po.notes, po.created_at,
            COALESCE(SUM(poi.qty * poi.unit_price), 0)::float AS total,
            (SELECT ar.status FROM approval_requests ar
             WHERE ar.company_id = po.company_id AND ar.module_type = 'PURCHASE_ORDER' AND ar.reference_id = po.id
             ORDER BY ar.created_at DESC LIMIT 1) AS approval_status
     FROM purchase_orders po
     LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
     LEFT JOIN locations l ON l.id = po.location_id AND l.company_id = po.company_id
     LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
     WHERE ${where}
     GROUP BY po.id, s.name, l.name
     ORDER BY po.created_at DESC`,
    params
  );
  res.status(200).json({ success: true, purchase_orders: result.rows });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query(
    `SELECT po.id, po.supplier_id, s.name AS supplier_name, po.status, po.order_date, po.expected_date,
            po.received_date, po.location_id, l.name AS location_name, po.notes, po.created_at,
            (SELECT ar.status FROM approval_requests ar
             WHERE ar.company_id = po.company_id AND ar.module_type = 'PURCHASE_ORDER' AND ar.reference_id = po.id
             ORDER BY ar.created_at DESC LIMIT 1) AS approval_status
     FROM purchase_orders po
     LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
     LEFT JOIN locations l ON l.id = po.location_id AND l.company_id = po.company_id
     WHERE po.id = $1 AND po.company_id = $2`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Purchase order not found');

  const items = await fetchItems(id as string, companyId);
  res.status(200).json({ success: true, purchase_order: result.rows[0], items });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { supplier_id, order_date, expected_date, notes, items } = req.body ?? {};

  const itemList = validateItems(items);
  await assertRawMaterialsInCompany(itemList.map((it) => it.raw_material_id), companyId);

  if (supplier_id) {
    const sup = await pool.query('SELECT id FROM suppliers WHERE id = $1 AND company_id = $2', [supplier_id, companyId]);
    if (sup.rows.length === 0) throw new AppError(400, 'supplier_id not found');
  }

  const client = await pool.connect();
  let poId: string;
  try {
    await client.query('BEGIN');
    const poResult = await client.query(
      `INSERT INTO purchase_orders (company_id, supplier_id, order_date, expected_date, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [companyId, supplier_id ?? null, order_date ?? null, expected_date ?? null, notes ?? null, req.auth!.userId]
    );
    poId = poResult.rows[0].id;

    for (const it of itemList) {
      await client.query(
        `INSERT INTO purchase_order_items (purchase_order_id, raw_material_id, qty, unit_price) VALUES ($1, $2, $3, $4)`,
        [poId, it.raw_material_id, it.qty, it.unit_price]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'purchase_order_created', entityType: 'purchase_orders', entityId: poId, req });

  res.status(201).json({ success: true, purchase_order: { id: poId } });
});

// Draft-only: replace scalar fields and/or the full item list. Once a PO is ordered
// or received it's locked — cancel and create a new one instead of editing history.
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { supplier_id, order_date, expected_date, notes, items, status } = req.body ?? {};

  const existing = await pool.query('SELECT status FROM purchase_orders WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Purchase order not found');
  const currentStatus = existing.rows[0].status;

  // status transitions: draft -> ordered, ordered -> cancelled, draft -> cancelled.
  // 'received' only ever happens via the dedicated receive() endpoint below.
  if (status !== undefined) {
    const allowed: Record<string, string[]> = { draft: ['ordered', 'cancelled'], ordered: ['cancelled'] };
    if (!allowed[currentStatus]?.includes(status)) {
      throw new AppError(400, `Cannot move a ${currentStatus} purchase order to ${status}`);
    }
  } else if (currentStatus !== 'draft') {
    throw new AppError(400, 'Only draft purchase orders can be edited — cancel and create a new one instead');
  }

  // MIGRATION_058 — Maker-Checker gate on "Send to Supplier" (draft -> ordered): the
  // real commitment point (money owed to a supplier), gated the same way payroll's
  // pay() is — but ONLY for Gold+ companies. /api/purchase-orders itself is
  // Silver-gated (app.ts) while /api/approvals is Gold-gated, so a Silver company
  // forced through this gate would have no route to ever approve its own PO — see
  // financialApprovals.ts's header. A below-Gold company keeps the original instant
  // draft->ordered transition untouched. This intentionally does NOT touch
  // draft->cancelled or ordered->cancelled — cancelling isn't a new financial
  // commitment, only placing the order is.
  if (status === 'ordered' && currentStatus === 'draft' && (await isCompanyGoldPlus(companyId))) {
    const latest = await getLatestApproval(companyId, 'PURCHASE_ORDER', id as string);
    if (latest?.status === 'pending') {
      throw new AppError(400, 'This purchase order is already awaiting approval.');
    }
    if (latest?.status !== 'approved') {
      await fileApprovalRequest(companyId, 'PURCHASE_ORDER', id as string, req.auth!.userId);
      await logAudit({
        companyId,
        userId: req.auth!.userId,
        action: 'purchase_order_submitted_for_approval',
        entityType: 'purchase_orders',
        entityId: id as string,
        req,
      });
      res.status(200).json({ success: true, submitted_for_approval: true });
      return;
    }
  }

  if (supplier_id !== undefined && supplier_id) {
    const sup = await pool.query('SELECT id FROM suppliers WHERE id = $1 AND company_id = $2', [supplier_id, companyId]);
    if (sup.rows.length === 0) throw new AppError(400, 'supplier_id not found');
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
    if (supplier_id !== undefined) set('supplier_id', supplier_id || null);
    if (order_date !== undefined) set('order_date', order_date || null);
    if (expected_date !== undefined) set('expected_date', expected_date || null);
    if (notes !== undefined) set('notes', notes || null);
    if (status !== undefined) set('status', status);
    if (sets.length > 0) {
      sets.push('updated_at = NOW()');
      values.push(id, companyId);
      await client.query(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++}`, values);
    }

    if (items !== undefined) {
      const itemList = validateItems(items);
      await assertRawMaterialsInCompany(itemList.map((it) => it.raw_material_id), companyId);
      await client.query(`DELETE FROM purchase_order_items WHERE purchase_order_id = $1`, [id]);
      for (const it of itemList) {
        await client.query(
          `INSERT INTO purchase_order_items (purchase_order_id, raw_material_id, qty, unit_price) VALUES ($1, $2, $3, $4)`,
          [id, it.raw_material_id, it.qty, it.unit_price]
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

  await logAudit({ companyId, userId: req.auth!.userId, action: 'purchase_order_updated', entityType: 'purchase_orders', entityId: id as string, req });

  const full = await pool.query(
    `SELECT po.id, po.supplier_id, s.name AS supplier_name, po.status, po.order_date, po.expected_date,
            po.received_date, po.location_id, l.name AS location_name, po.notes, po.created_at,
            (SELECT ar.status FROM approval_requests ar
             WHERE ar.company_id = po.company_id AND ar.module_type = 'PURCHASE_ORDER' AND ar.reference_id = po.id
             ORDER BY ar.created_at DESC LIMIT 1) AS approval_status
     FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id LEFT JOIN locations l ON l.id = po.location_id AND l.company_id = po.company_id
     WHERE po.id = $1`,
    [id]
  );
  const items2 = await fetchItems(id as string, companyId);
  res.status(200).json({ success: true, purchase_order: full.rows[0], items: items2 });
});

// Marks the PO as received and creates one raw_material_batches row per item at the
// given location — same shape a manual batch entry already produces (purchase_price =
// the PO's unit_price, purchase_date = today, qty_remaining = qty ordered). Full
// receive only, no partial lines — matches the rest of this simplified workflow.
export const receive = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { location_id } = req.body ?? {};

  if (typeof location_id !== 'string') throw new AppError(400, 'location_id is required to receive a purchase order');
  const loc = await pool.query('SELECT id FROM locations WHERE id = $1 AND company_id = $2', [location_id, companyId]);
  if (loc.rows.length === 0) throw new AppError(400, 'location_id not found');

  const po = await pool.query('SELECT status FROM purchase_orders WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!po.rows[0]) throw new AppError(404, 'Purchase order not found');
  if (po.rows[0].status !== 'ordered') throw new AppError(400, 'Only an "ordered" purchase order can be received');

  const items = await fetchItems(id as string, companyId);
  if (items.length === 0) throw new AppError(400, 'Purchase order has no items');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const it of items) {
      await client.query(
        `INSERT INTO raw_material_batches (company_id, raw_material_id, location_id, purchase_date, qty_purchased, qty_remaining, purchase_price)
         VALUES ($1, $2, $3, CURRENT_DATE, $4, $4, $5)`,
        [companyId, it.raw_material_id, location_id, it.qty, it.unit_price]
      );
    }

    await client.query(
      `UPDATE purchase_orders SET status = 'received', received_date = CURRENT_DATE, location_id = $1, updated_at = NOW()
       WHERE id = $2 AND company_id = $3`,
      [location_id, id, companyId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'purchase_order_received', entityType: 'purchase_orders', entityId: id as string, req });

  res.status(200).json({ success: true });
});

// Only a draft PO can be hard-deleted (nothing downstream references it yet).
// Ordered/received/cancelled POs stay as historical records.
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const existing = await pool.query('SELECT status FROM purchase_orders WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Purchase order not found');
  if (existing.rows[0].status !== 'draft') {
    throw new AppError(400, 'Only draft purchase orders can be deleted — cancel it instead');
  }

  await pool.query('DELETE FROM purchase_orders WHERE id = $1 AND company_id = $2', [id, companyId]);

  await logAudit({ companyId, userId: req.auth!.userId, action: 'purchase_order_deleted', entityType: 'purchase_orders', entityId: id as string, req });

  res.status(200).json({ success: true });
});
