// Runs docs/DATABASE_SCHEMA.sql against DATABASE_URL. Idempotent-ish: rerunning
// against an already-migrated DB will fail on "already exists" — that's fine,
// this is a one-shot bootstrap script, not a migration framework (add one when
// you need incremental migrations, e.g. node-pg-migrate).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — check that .env sits next to package.json and you ran this from the backend/ folder.');
    process.exitCode = 1;
    return;
  }

  const sqlPath = path.join(__dirname, '..', '..', 'docs', 'DATABASE_SCHEMA.sql');
  if (!fs.existsSync(sqlPath)) {
    console.error('Schema file not found at:', sqlPath);
    process.exitCode = 1;
    return;
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await pool.query(sql);
    console.log('Migration complete.');
  } catch (err) {
    console.error('Migration failed.');
    console.error('  message:', err && err.message);
    console.error('  code:', err && err.code);
    console.error('  detail:', err && err.detail);
    console.error('  position:', err && err.position);
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
