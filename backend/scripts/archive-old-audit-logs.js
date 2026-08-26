// Moves audit_logs rows older than the retention window into audit_logs_archive,
// then deletes them from the live table — batched, one transaction per batch, so a
// large backlog doesn't hold one giant lock or one giant transaction.
//
// Requires MIGRATION_065 to have been run first (it's what allows this script's
// DELETE to pass audit_logs' append-only trigger for rows past the retention
// window — everything inside the window stays fully protected, no exception).
//
// RETENTION_MONTHS must match the INTERVAL hardcoded in audit_logs_block_mutation()
// (MIGRATION_065) — if you change one, change both.
//
// This app has no in-process scheduler, so this is meant to be run periodically,
// not left as a one-off: point a Railway Cron Job service at
//   node scripts/archive-old-audit-logs.js
// running monthly (retention is a 12-month window, so monthly is frequent enough —
// no need for anything tighter). Safe to re-run any time: rows already archived are
// gone from audit_logs, so they're never selected again.
//
// Manual run (from the backend/ folder): node scripts/archive-old-audit-logs.js
require('dotenv').config();
const { Pool } = require('pg');

const RETENTION_MONTHS = 12;
const BATCH_SIZE = 5000;

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — check that .env sits next to package.json and you ran this from the backend/ folder.');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let totalArchived = 0;

  try {
    for (;;) {
      const client = await pool.connect();
      let batchSize = 0;
      try {
        await client.query('BEGIN');

        const { rows } = await client.query(
          `SELECT id FROM audit_logs
           WHERE created_at < NOW() - INTERVAL '${RETENTION_MONTHS} months'
           LIMIT $1`,
          [BATCH_SIZE]
        );
        batchSize = rows.length;

        if (batchSize > 0) {
          const ids = rows.map((r) => r.id);
          await client.query(
            `INSERT INTO audit_logs_archive
               (id, company_id, user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent, created_at)
             SELECT id, company_id, user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent, created_at
             FROM audit_logs
             WHERE id = ANY($1)
             ON CONFLICT (id) DO NOTHING`,
            [ids]
          );
          await client.query(`DELETE FROM audit_logs WHERE id = ANY($1)`, [ids]);
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      if (batchSize === 0) break;
      totalArchived += batchSize;
      console.log(`Archived batch of ${batchSize} rows (total so far: ${totalArchived})`);
    }

    console.log(totalArchived > 0 ? `✅ Done. Archived ${totalArchived} row(s).` : '✅ Nothing to archive — no rows past the retention window.');
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
