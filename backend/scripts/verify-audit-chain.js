// Walks every company's hash chain (MIGRATION_066) across audit_logs_archive (older
// rows) then audit_logs (newer rows) and confirms each row's hash both matches its
// own content AND correctly extends the previous row's hash. Read-only — never
// writes anything, safe to run anytime, as often as you like.
//
// Rows created before MIGRATION_066 have hash = NULL — expected and reported
// separately as "legacy (unchained)", not a failure. See that migration's header
// comment for why the chain was deliberately NOT backfilled onto historical data.
//
// The hash formula is mirrored exactly from MIGRATION_066's audit_logs_compute_hash()
// trigger function. created_at is fetched pre-cast to text (created_at::text) in the
// SQL itself, not reconstructed from a JS Date — Postgres's own ::text formatting is
// what the trigger used originally, and re-deriving that formatting in JS would risk
// spurious "broken chain" reports from a formatting mismatch, not a real tamper.
//
// Manual run (from the backend/ folder): node scripts/verify-audit-chain.js
require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');

function computeHash(prevHash, row) {
  const input = [
    prevHash || '',
    row.id,
    row.company_id,
    row.user_id || '',
    row.action || '',
    row.entity_type || '',
    row.entity_id || '',
    row.created_at_text || '',
  ].join('|');
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

const ROW_QUERY = `
  SELECT id, company_id, user_id, action, entity_type, entity_id,
         created_at::text AS created_at_text, prev_hash, hash
  FROM %TABLE%
  WHERE company_id = $1
  ORDER BY created_at ASC, id ASC
`;

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — check that .env sits next to package.json and you ran this from the backend/ folder.');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let brokenCompanies = 0;
  let checkedCompanies = 0;

  try {
    const companiesResult = await pool.query(`
      SELECT DISTINCT company_id FROM audit_logs
      UNION
      SELECT DISTINCT company_id FROM audit_logs_archive
    `);

    for (const { company_id: companyId } of companiesResult.rows) {
      checkedCompanies++;

      // Archive rows are always older than every live row for the same company (the
      // archiving script only ever moves rows past the retention window) — a plain
      // concatenation in this order is already correct chronological order, no merge
      // needed.
      const archiveRows = (await pool.query(ROW_QUERY.replace('%TABLE%', 'audit_logs_archive'), [companyId])).rows;
      const liveRows = (await pool.query(ROW_QUERY.replace('%TABLE%', 'audit_logs'), [companyId])).rows;
      const rows = [...archiveRows, ...liveRows];

      let expectedPrevHash = null;
      let legacyCount = 0;
      let chainedCount = 0;
      let broken = null;

      for (const row of rows) {
        if (row.hash === null) {
          legacyCount++;
          continue;
        }
        if (row.prev_hash !== expectedPrevHash) {
          broken = { row, reason: 'prev_hash does not match the previous row in the chain' };
          break;
        }
        const recomputed = computeHash(expectedPrevHash, row);
        if (recomputed !== row.hash) {
          broken = { row, reason: 'stored hash does not match the row\'s own content — possible tampering' };
          break;
        }
        expectedPrevHash = row.hash;
        chainedCount++;
      }

      if (broken) {
        brokenCompanies++;
        console.log(`❌ Company ${companyId}: chain BROKEN at audit_log id ${broken.row.id} (${broken.reason}).`);
      } else {
        console.log(`✅ Company ${companyId}: chain intact — ${chainedCount} chained row(s), ${legacyCount} legacy (pre-hash-chain) row(s).`);
      }
    }

    console.log('');
    if (brokenCompanies > 0) {
      console.log(`❌ Done. ${brokenCompanies} of ${checkedCompanies} company chain(s) broken — see above.`);
      process.exitCode = 1;
    } else {
      console.log(`✅ Done. All ${checkedCompanies} company chain(s) intact.`);
    }
  } catch (err) {
    console.error('❌ Failed.');
    console.error('  message:', err && err.message);
    console.error('  code:', err && err.code);
    console.error('  detail:', err && err.detail);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
