import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { createSaleTx } from '../services/salesService';
import { resolveCommissionPct } from '../utils/commission';

// Scope of this Phase 2 sync implementation: the `sales` table only — the one thing
// a kiosk actually needs to record while offline. Sales are treated as an append-only
// log (voids are a separate DELETE, not a sync'd "update"), so pull/push here don't
// need the general version_history-based multi-table merge machinery the schema has
// room for. Add that per-table when a second offline-writable entity shows up.

export const pull = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { last_sync_timestamp } = req.body ?? {};
  const since = typeof last_sync_timestamp === 'string' ? last_sync_timestamp : '1970-01-01T00:00:00Z';

  const result = await pool.query(
    `SELECT id, shift_id, product_id, product_size_id, qty, unit_price, total_price, payment_method, app_commission_pct, created_at, created_by, version
     FROM sales WHERE company_id = $1 AND created_at > $2 ORDER BY created_at ASC LIMIT 500`,
    [companyId, since]
  );

  const changes = result.rows.map((row) => ({
    table: 'sales',
    record_id: row.id,
    version: row.version,
    new_values: row,
    changed_at: row.created_at,
  }));

  res.status(200).json({ success: true, changes, timestamp: new Date().toISOString() });
});

export const push = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { changes } = req.body ?? {};
  if (!Array.isArray(changes)) throw new AppError(400, 'changes must be an array');

  const conflicts: unknown[] = [];
  const applied: unknown[] = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const change of changes) {
      if (change?.table !== 'sales' || change?.op !== 'insert') {
        throw new AppError(400, `unsupported change: table=${change?.table} op=${change?.op} — only sales inserts sync right now`);
      }
      if (typeof change.id !== 'string') throw new AppError(400, 'each change needs a client-generated id');
      const data = change.data ?? {};

      const existing = await client.query('SELECT id, qty, total_price FROM sales WHERE id = $1 AND company_id = $2', [change.id, companyId]);
      if (existing.rows[0]) {
        // Already synced — most likely a retried push after a dropped connection. Idempotent no-op,
        // unless the incoming payload actually disagrees with what's stored, in which case the
        // server row wins (it already affected stock) and the mismatch is logged for a human to check.
        // Only compare client-authoritative fields — total_price/unit_price are server-computed and
        // the client never sends them, so comparing those would flag every idempotent retry as a conflict.
        const same = Number(existing.rows[0].qty) === Number(data.qty);
        if (!same) {
          await client.query(
            `INSERT INTO conflict_log (company_id, table_name, record_id, server_version, client_version, resolution)
             VALUES ($1, 'sales', $2, $3, $4, 'server_won')`,
            [companyId, change.id, JSON.stringify(existing.rows[0]), JSON.stringify(data)]
          );
          conflicts.push({ record_id: change.id, resolution: 'server_won' });
        }
        continue;
      }

      const commissionPct = await resolveCommissionPct(companyId, data.payment_method, req.auth!.role, data.app_commission_pct);
      const result = await createSaleTx(client, {
        id: change.id,
        companyId,
        shiftId: data.shift_id,
        productId: data.product_id,
        productSizeId: data.product_size_id ?? null,
        qty: data.qty,
        unitPrice: data.unit_price,
        paymentMethod: data.payment_method,
        appCommissionPct: commissionPct,
        createdBy: req.auth!.userId,
      });
      applied.push(result.sale);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.status(200).json({ success: true, synced: true, applied_count: applied.length, conflicts, timestamp: new Date().toISOString() });
});
