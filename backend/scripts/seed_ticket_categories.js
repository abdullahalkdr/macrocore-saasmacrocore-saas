// One-off, idempotent seed: inserts the 7 legacy hardcoded ticket categories
// (supportTickets.controller.ts's CATEGORIES / HR_CATEGORIES arrays) into the
// new ticket_categories table for every existing company, so tenants have
// real rows to pick from via /api/ticket-categories instead of only the
// hardcoded string list. Safe to re-run — skips a company+name_en pair
// that's already there instead of inserting a duplicate.
//
// Plain .js (not .ts) deliberately, matching every other script in this
// folder (promote-admin.js, migrate.js, run-sql.js, query.js) — none of them
// run through ts-node, they're all `node scripts/x.js` directly.
//
// Usage (from the backend/ folder): node scripts/seed_ticket_categories.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Keep this in lockstep with supportTickets.controller.ts's CATEGORIES /
// HR_CATEGORIES arrays — this script exists specifically to migrate that
// hardcoded list into real per-company rows.
const DEFAULT_CATEGORIES = [
  { name: 'عام', name_en: 'General', is_hr_sensitive: false },
  { name: 'إجازة', name_en: 'Leave', is_hr_sensitive: true },
  { name: 'شكوى', name_en: 'Grievance', is_hr_sensitive: true },
  { name: 'طلب مستند', name_en: 'Document Request', is_hr_sensitive: true },
  { name: 'الرواتب', name_en: 'Payroll', is_hr_sensitive: true },
  { name: 'تقنية المعلومات', name_en: 'IT', is_hr_sensitive: false },
  { name: 'أخرى', name_en: 'Other', is_hr_sensitive: false },
];

async function run() {
  const { rows: companies } = await pool.query('SELECT id, name FROM companies');
  console.log(`Found ${companies.length} companies.`);

  let inserted = 0;
  let skipped = 0;

  for (const company of companies) {
    const { rows: existing } = await pool.query(
      'SELECT name_en FROM ticket_categories WHERE company_id = $1',
      [company.id]
    );
    const existingNamesEn = new Set(existing.map((r) => r.name_en));

    for (const cat of DEFAULT_CATEGORIES) {
      if (existingNamesEn.has(cat.name_en)) {
        skipped++;
        continue;
      }
      await pool.query(
        `INSERT INTO ticket_categories (company_id, name, name_en, is_hr_sensitive)
         VALUES ($1, $2, $3, $4)`,
        [company.id, cat.name, cat.name_en, cat.is_hr_sensitive]
      );
      inserted++;
    }
  }

  console.log(`Done. Inserted ${inserted} categories, skipped ${skipped} already present.`);
  await pool.end();
}

run().catch((err) => {
  console.error('Failed:', err.message);
  pool.end();
  process.exitCode = 1;
});
