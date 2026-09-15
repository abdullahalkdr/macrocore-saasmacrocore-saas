#!/usr/bin/env node
// Read-only preflight for MIGRATION_082. This script is intentionally allowed
// to inspect a real database: it issues SELECT statements only and never reads
// or changes application environment files.
//
// PowerShell:
//   $env:DATABASE_URL = '<connection string>'
//   node docs/PREFLIGHT_B2_subscriptions_schema_check.js

const { Client } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');

const TARGET_COLUMNS = [
  'currency',
  'billing_interval',
  'current_period_start',
  'current_period_end',
  'period_amount',
];
const TARGET_CONSTRAINTS = [
  'subscriptions_currency_supported',
  'subscriptions_billing_interval_valid',
  'subscriptions_period_amount_positive',
  'subscriptions_period_end_after_start',
];
const TARGET_INDEX = 'subscriptions_one_live_per_company';

async function main() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    console.error('Set DATABASE_URL to the database you want to inspect and re-run.');
    process.exitCode = 1;
    return;
  }

  const parsed = parseConnectionString(rawUrl);
  console.log(`Inspecting database "${parsed.database || '(unspecified)'}" on host "${parsed.host || '(unspecified)'}" (read-only).`);

  const client = new Client({ connectionString: rawUrl });
  await client.connect();

  try {
    const table = await client.query(
      `SELECT to_regclass(format('%I.%I', current_schema(), 'subscriptions'))::text AS relation`
    );
    if (!table.rows[0]?.relation) {
      throw new Error('subscriptions table was not found in current_schema()');
    }

    const columns = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'subscriptions'
       ORDER BY ordinal_position`
    );
    const count = await client.query('SELECT COUNT(*)::int AS n FROM subscriptions');
    const statuses = await client.query(
      'SELECT status, COUNT(*)::int AS n FROM subscriptions GROUP BY status ORDER BY status'
    );
    const duplicates = await client.query(
      `SELECT company_id, COUNT(*)::int AS n
       FROM subscriptions
       WHERE status IN ('active','past_due')
       GROUP BY company_id
       HAVING COUNT(*) > 1`
    );
    const constraints = await client.query(
      `SELECT conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = current_schema() AND t.relname = 'subscriptions'
       ORDER BY conname`
    );
    const indexes = await client.query(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'subscriptions'
       ORDER BY indexname`
    );

    console.log('\n=== subscriptions: current columns ===');
    console.table(columns.rows);
    console.log(`\n=== row count: ${count.rows[0].n} ===`);
    console.log('\n=== existing statuses ===');
    console.table(statuses.rows);
    console.log(`\n=== duplicate live subscriptions: ${duplicates.rows.length} ===`);
    if (duplicates.rows.length) console.table(duplicates.rows);
    console.log('\n=== constraints ===');
    console.table(constraints.rows);
    console.log('\n=== indexes ===');
    console.table(indexes.rows);

    const columnNames = new Set(columns.rows.map((row) => row.column_name));
    const presentColumns = TARGET_COLUMNS.filter((name) => columnNames.has(name));
    const constraintNames = new Set(constraints.rows.map((row) => row.conname));
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    const presentConstraints = TARGET_CONSTRAINTS.filter((name) => constraintNames.has(name));
    const allColumnsPresent = presentColumns.length === TARGET_COLUMNS.length;
    const allConstraintsPresent = TARGET_CONSTRAINTS.every((name) => constraintNames.has(name));
    const indexPresent = indexNames.has(TARGET_INDEX);

    if (duplicates.rows.length) {
      console.log('\n>>> STOP: the partial unique index cannot be created until these rows are reviewed manually.');
    } else if (allColumnsPresent && allConstraintsPresent && indexPresent) {
      console.log('\n>>> MIGRATION_082 appears to be already applied. Do not run it again; share this output for verification.');
    } else if (presentColumns.length > 0 || presentConstraints.length > 0 || indexPresent) {
      console.log('\n>>> STOP: the migration appears partially applied or the schema overlaps with it. Do not run it as-is; share this output.');
    } else if (count.rows[0].n > 0) {
      console.log('\n>>> STOP: the table is not empty. The current NOT NULL migration will fail; prepare a nullable compatibility migration after reviewing these rows.');
    } else {
      console.log('\n>>> Preflight passed: the table is empty, target objects are absent, and no duplicate live rows exist. MIGRATION_082 is structurally applicable; it has not been executed by this check.');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Preflight check failed:', err.message);
  process.exitCode = 1;
});
