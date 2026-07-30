// Runs any .sql file against DATABASE_URL — no psql install needed, works the same
// on Windows/macOS/Linux since it just uses the `pg` package already in package.json.
//
// Usage (from the backend/ folder):
//   node scripts/run-sql.js docs/MIGRATION_005_raw_material_batches.sql
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function run() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('Usage: node scripts/run-sql.js <path-to-sql-file>');
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — check that .env sits next to package.json and you ran this from the backend/ folder.');
    process.exitCode = 1;
    return;
  }

  const sqlPath = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(sqlPath)) {
    console.error('SQL file not found at:', sqlPath);
    process.exitCode = 1;
    return;
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log('Running:', sqlPath);

  try {
    await pool.query(sql);
    console.log('✅ Done.');
  } catch (err) {
    console.error('❌ Failed.');
    console.error('  message:', err && err.message);
    console.error('  code:', err && err.code);
    console.error('  detail:', err && err.detail);
    console.error('  position:', err && err.position);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
