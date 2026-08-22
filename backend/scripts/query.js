// Runs a single SQL query against DATABASE_URL and prints the result rows as a table
// — run-sql.js/migrate.js only report success/failure, not row output, so this fills
// that gap for manual QA/verification. See docs/POLICIES_MODULE_QA_TESTING_PLAN.md.
//
// Usage (from the backend/ folder):
//   node scripts/query.js "SELECT * FROM policies ORDER BY created_at DESC LIMIT 5"
require('dotenv').config();
const { Pool } = require('pg');

async function run() {
  const sql = process.argv[2];
  if (!sql) {
    console.error('Usage: node scripts/query.js "<SQL query>"');
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — check that .env sits next to package.json and you ran this from the backend/ folder.');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query(sql);
    if (result.rows.length === 0) {
      console.log('(0 rows)');
    } else {
      console.table(result.rows);
    }
  } catch (err) {
    console.error('❌ Query failed.');
    console.error('  message:', err && err.message);
    console.error('  detail:', err && err.detail);
  } finally {
    await pool.end();
  }
}

run();
