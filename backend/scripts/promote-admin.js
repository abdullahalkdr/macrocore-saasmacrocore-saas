// One-off fix: promotes a user (matched by email) to role = 'admin'.
// Usage (from the backend/ folder): node scripts/promote-admin.js you@example.com
require('dotenv').config();
const { Pool } = require('pg');

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/promote-admin.js <email>');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool
  .query('UPDATE users SET role = $1, updated_at = NOW() WHERE email = $2 RETURNING email, role, company_id', ['admin', email.toLowerCase()])
  .then((r) => {
    if (r.rows.length === 0) {
      console.log('No user found with that email.');
    } else {
      console.log('Updated:', r.rows[0]);
    }
    pool.end();
  })
  .catch((err) => {
    console.error('Failed:', err.message);
    pool.end();
    process.exitCode = 1;
  });
