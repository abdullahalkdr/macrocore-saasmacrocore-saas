import { pool } from '../db/pool';

// MIGRATION_057 — generic, concurrency-safe monotonic counter keyed by
// (company_id, prefix). Not ticket-specific: any future document type (invoice
// numbers, PO numbers, etc.) can reuse this by choosing its own prefix scheme,
// without a new table per document type. See the migration's own header for the
// full design rationale.
//
// Concurrency: the SELECT ... FOR UPDATE inside this transaction is the actual
// guard, not the UNIQUE(company_id, prefix) constraint by itself. Two concurrent
// callers for the same prefix serialize on that row's lock — the second caller's
// SELECT ... FOR UPDATE blocks until the first COMMITs, then reads the value the
// first just wrote. Neither can read-then-write the same current_value, so no
// duplicate numbers are possible even under real concurrent ticket creation.
export async function generateNextSequence(companyId: string, prefix: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The row must exist before it can be locked. A plain insert the first time
    // this prefix is ever used; ON CONFLICT DO NOTHING makes this safe even if
    // another concurrent transaction is inserting the same (company_id, prefix)
    // at the same instant — one of the two inserts wins, the other silently
    // no-ops, and both then proceed to the SELECT ... FOR UPDATE below.
    await client.query(
      `INSERT INTO document_sequences (company_id, prefix, current_value) VALUES ($1, $2, 0)
       ON CONFLICT (company_id, prefix) DO NOTHING`,
      [companyId, prefix]
    );

    const locked = await client.query(
      `SELECT current_value FROM document_sequences WHERE company_id = $1 AND prefix = $2 FOR UPDATE`,
      [companyId, prefix]
    );
    const next = (locked.rows[0]?.current_value ?? 0) + 1;

    await client.query(`UPDATE document_sequences SET current_value = $1 WHERE company_id = $2 AND prefix = $3`, [
      next,
      companyId,
      prefix,
    ]);

    await client.query('COMMIT');
    return next;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Ticket-numbering convention: [DEPT]-[YYMM]-[XXXX], e.g. IT-2608-0001. The
// year+month is baked directly into the prefix rather than a separate column —
// see MIGRATION_057 decision 3 — so the sequence naturally resets to 1 every
// month per department with zero extra logic; a new (company_id, prefix) row is
// just created the first time a given department+month combination is used.
export async function generateTicketNumber(companyId: string, departmentCode: string): Promise<string> {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `${departmentCode}-${yy}${mm}`;
  const seq = await generateNextSequence(companyId, prefix);
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

// Approval-request numbering: APR-[YYMM]-[XXXX], e.g. APR-2608-0001. Same generic
// counter as generateTicketNumber, no per-department prefix needed here -- a
// company's approval requests span every module_type (payroll/PO/expense/ITSM
// ticket) in one shared numbered feed, so reviewers can match a notification in the
// bell to the right row in the Approvals inbox even when the same employee has
// filed more than one similar request.
export async function generateApprovalRequestNumber(companyId: string): Promise<string> {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `APR-${yy}${mm}`;
  const seq = await generateNextSequence(companyId, prefix);
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}
