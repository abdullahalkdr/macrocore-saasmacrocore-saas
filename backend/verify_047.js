// One-off check — confirms MIGRATION_047's data migration landed correctly.
// Run from the backend/ folder: node verify_047.js
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    const a = await pool.query('SELECT count(*)::int n FROM ticket_categories');
    const b = await pool.query('SELECT count(*)::int n FROM service_categories');
    const c = await pool.query('SELECT count(*)::int n FROM service_request_types');
    const d = await pool.query('SELECT count(*)::int n FROM support_tickets WHERE category_id IS NOT NULL');
    const e = await pool.query('SELECT count(*)::int n FROM support_tickets WHERE request_type_id IS NOT NULL');

    console.log('ticket_categories (old):        ', a.rows[0].n);
    console.log('service_categories (new):       ', b.rows[0].n, a.rows[0].n === b.rows[0].n ? '✅ matches' : '❌ MISMATCH');
    console.log('service_request_types (new):    ', c.rows[0].n, a.rows[0].n === c.rows[0].n ? '✅ matches' : '❌ MISMATCH');
    console.log('tickets with category_id:       ', d.rows[0].n);
    console.log('tickets with request_type_id:   ', e.rows[0].n, d.rows[0].n === e.rows[0].n ? '✅ matches' : '❌ MISMATCH');
  } catch (err) {
    console.error('❌ Failed:', err.message);
  } finally {
    await pool.end();
  }
})();
