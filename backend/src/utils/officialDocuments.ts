import { PoolClient } from 'pg';

const PREFIX = 'COR';

// Next reference number for a company/year, e.g. "COR-2026-0004". Sequential per
// company per year, based on the highest existing sequence number for that year — not
// a dedicated counter table, so a burst of concurrent creates could theoretically race
// (acceptable at this business's scale; see docs/ADVANCED_PAYROLL... for the same
// tradeoff reasoning elsewhere in this codebase). Parsed in JS rather than a SQL regex
// extraction, to stay portable with the pg-mem smoke-test engine.
export async function nextReferenceNumber(client: PoolClient, companyId: string, year: number): Promise<string> {
  const likePattern = `${PREFIX}-${year}-%`;
  const result = await client.query(
    `SELECT reference_number FROM official_documents WHERE company_id = $1 AND reference_number LIKE $2`,
    [companyId, likePattern]
  );

  let maxSeq = 0;
  for (const row of result.rows) {
    const parts = String(row.reference_number).split('-');
    const seq = parseInt(parts[2], 10);
    if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
  }

  const nextSeq = maxSeq + 1;
  return `${PREFIX}-${year}-${String(nextSeq).padStart(4, '0')}`;
}
