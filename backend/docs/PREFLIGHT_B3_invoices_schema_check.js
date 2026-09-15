#!/usr/bin/env node
// Read-only preflight for MIGRATION_083. This script is intentionally allowed
// to inspect a real database: it issues SELECT statements only and never
// reads or changes application environment files. Mirrors the structure of
// docs/PREFLIGHT_B2_subscriptions_schema_check.js.
//
// PowerShell:
//   $env:DATABASE_URL = '<connection string>'
//   node docs/PREFLIGHT_B3_invoices_schema_check.js

const { Client } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');

// Columns MIGRATION_083 adds. (subscription_id/issue_date/due_date/created_at/
// amount/status already exist pre-migration and are checked separately below
// for their CURRENT type/nullability, since this migration tightens them
// rather than adding them.)
const TARGET_NEW_COLUMNS = ['plan', 'billing_interval', 'currency', 'period_start', 'period_end', 'invoice_number'];
const TARGET_CONSTRAINTS = [
  'invoices_amount_positive',
  'invoices_currency_supported',
  'invoices_billing_interval_valid',
  'invoices_period_end_after_start',
  'invoices_due_on_or_after_issue',
  'invoices_status_valid',
  'invoices_one_invoice_per_period',
  'invoices_number_unique',
];
const TARGET_SEQUENCE = 'macrocore_invoice_number_seq';
const EXPECTED_COMPANY_FK_NAME = 'invoices_company_id_fkey';

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
      `SELECT to_regclass(format('%I.%I', current_schema(), 'invoices'))::text AS relation`
    );
    if (!table.rows[0]?.relation) {
      throw new Error('invoices table was not found in current_schema()');
    }

    const columns = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'invoices'
       ORDER BY ordinal_position`
    );
    const count = await client.query('SELECT COUNT(*)::int AS n FROM invoices');
    const statuses = await client.query(
      'SELECT status, COUNT(*)::int AS n FROM invoices GROUP BY status ORDER BY status'
    );
    const constraints = await client.query(
      `SELECT conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = current_schema() AND t.relname = 'invoices'
       ORDER BY conname`
    );
    const indexes = await client.query(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'invoices'
       ORDER BY indexname`
    );
    const sequenceExists = await client.query(
      `SELECT to_regclass(format('%I.%I', current_schema(), $1::text))::text AS relation`,
      [TARGET_SEQUENCE]
    );
    // Only meaningful once period_start/period_end exist; before this
    // migration they do not, so this always returns zero rows pre-migration
    // — included for completeness / to be re-run after the migration lands
    // if ever needed again.
    const columnNamesPre = new Set(columns.rows.map((row) => row.column_name));
    let duplicateCandidates = { rows: [] };
    if (columnNamesPre.has('period_start') && columnNamesPre.has('period_end')) {
      duplicateCandidates = await client.query(
        `SELECT subscription_id, period_start, period_end, COUNT(*)::int AS n
         FROM invoices
         GROUP BY subscription_id, period_start, period_end
         HAVING COUNT(*) > 1`
      );
    }

    console.log('\n=== invoices: current columns ===');
    console.table(columns.rows);
    console.log(`\n=== row count: ${count.rows[0].n} ===`);
    console.log('\n=== existing statuses ===');
    console.table(statuses.rows);
    console.log('\n=== constraints ===');
    console.table(constraints.rows);
    console.log('\n=== indexes ===');
    console.table(indexes.rows);
    console.log(`\n=== sequence "${TARGET_SEQUENCE}" exists: ${!!sequenceExists.rows[0]?.relation} ===`);
    console.log(`\n=== duplicate (subscription_id, period_start, period_end) candidates: ${duplicateCandidates.rows.length} ===`);
    if (duplicateCandidates.rows.length) console.table(duplicateCandidates.rows);

    const companyFk = constraints.rows.find((row) => row.definition.includes('FOREIGN KEY (company_id)'));
    console.log('\n=== invoices.company_id foreign key (current) ===');
    if (companyFk) {
      console.log(`${companyFk.conname}: ${companyFk.definition}`);
    } else {
      console.log('(none)');
    }

    const constraintNames = new Set(constraints.rows.map((row) => row.conname));
    const constraintsByName = new Map(constraints.rows.map((row) => [row.conname, row.definition]));
    const columnsByName = new Map(columns.rows.map((row) => [row.column_name, row]));
    const presentNewColumns = TARGET_NEW_COLUMNS.filter((name) => columnNamesPre.has(name));
    const presentConstraints = TARGET_CONSTRAINTS.filter((name) => constraintNames.has(name));
    const allNewColumnsPresent = presentNewColumns.length === TARGET_NEW_COLUMNS.length;
    const allConstraintsPresent = TARGET_CONSTRAINTS.every((name) => constraintNames.has(name));
    const sequencePresent = !!sequenceExists.rows[0]?.relation;

    const columnIs = (name, type, nullable) => {
      const col = columnsByName.get(name);
      return !!col && col.data_type === type && col.is_nullable === nullable;
    };
    const legacyShapeMatches =
      columnIs('subscription_id', 'uuid', 'YES') &&
      columnIs('amount', 'numeric', 'YES') &&
      columnIs('status', 'character varying', 'YES') &&
      columnIs('issue_date', 'timestamp without time zone', 'YES') &&
      columnIs('due_date', 'timestamp without time zone', 'YES') &&
      columnIs('created_at', 'timestamp without time zone', 'YES');
    const appliedShapeMatches =
      columnIs('subscription_id', 'uuid', 'NO') &&
      columnIs('amount', 'numeric', 'NO') &&
      columnIs('status', 'character varying', 'NO') &&
      columnIs('issue_date', 'timestamp with time zone', 'NO') &&
      columnIs('due_date', 'timestamp with time zone', 'NO') &&
      columnIs('created_at', 'timestamp with time zone', 'NO') &&
      columnIs('plan', 'character varying', 'NO') &&
      columnIs('billing_interval', 'character varying', 'NO') &&
      columnIs('currency', 'character varying', 'NO') &&
      columnIs('period_start', 'timestamp with time zone', 'NO') &&
      columnIs('period_end', 'timestamp with time zone', 'NO') &&
      columnIs('invoice_number', 'character varying', 'NO') &&
      /macrocore_invoice_number_seq/i.test(columnsByName.get('invoice_number')?.column_default || '') &&
      /issued/i.test(columnsByName.get('status')?.column_default || '');

    // Exact (whitespace-normalized) equality against MIGRATION_083's real,
    // captured pg_get_constraintdef() output — not fragment regexes. A loose
    // fragment like /amount\s*>/ also matches a WEAKENED "amount >= (0)"
    // definition (">" is a substring of ">="), which would let a silently
    // relaxed constraint pass as "already applied and matches expected
    // shape". Exact-string comparison was verified against this real
    // Postgres version's own rendering (see the six-state preflight
    // verification in the B3 review round) — normalizing only outer/inner
    // run-length whitespace, never the operators, quoting, or casts
    // themselves, so a genuine definition change is never masked.
    const normalizeDef = (def) => (def || '').replace(/\s+/g, ' ').trim();
    const EXPECTED_CONSTRAINT_DEFS = {
      invoices_amount_positive: 'CHECK ((amount > (0)::numeric))',
      invoices_currency_supported:
        "CHECK (((currency)::text = ANY ((ARRAY['USD'::character varying, 'KWD'::character varying])::text[])))",
      invoices_billing_interval_valid:
        "CHECK (((billing_interval)::text = ANY ((ARRAY['monthly'::character varying, 'annual'::character varying])::text[])))",
      invoices_period_end_after_start: 'CHECK ((period_end > period_start))',
      invoices_due_on_or_after_issue: 'CHECK ((due_date >= issue_date))',
      invoices_status_valid: "CHECK (((status)::text = 'issued'::text))",
      invoices_one_invoice_per_period: 'UNIQUE (subscription_id, period_start, period_end)',
      invoices_number_unique: 'UNIQUE (invoice_number)',
    };
    const constraintDefMismatches = Object.entries(EXPECTED_CONSTRAINT_DEFS)
      .filter(([name, expected]) => normalizeDef(constraintsByName.get(name)) !== normalizeDef(expected))
      .map(([name]) => name);
    const constraintDefinitionMatches = constraintDefMismatches.length === 0;

    const fkNameMatches = companyFk?.conname === EXPECTED_COMPANY_FK_NAME;
    const fkIsCascade = fkNameMatches && /ON DELETE CASCADE/i.test(companyFk.definition);
    const fkIsRestrict = fkNameMatches && /ON DELETE RESTRICT/i.test(companyFk.definition);
    const stop = (message) => {
      console.log(`\n>>> STOP: ${message}`);
      process.exitCode = 2;
    };

    if (duplicateCandidates.rows.length) {
      stop('the per-period unique constraint cannot be created until these duplicate rows are reviewed manually.');
    } else if (allNewColumnsPresent && allConstraintsPresent && sequencePresent) {
      if (appliedShapeMatches && constraintDefinitionMatches && fkIsRestrict) {
        console.log('\n>>> MIGRATION_083 is already applied and its columns, defaults, constraints, sequence, and RESTRICT foreign key match the expected shape. Do not run it again.');
      } else {
        const reasons = [];
        if (!appliedShapeMatches) reasons.push('one or more column types/nullability/defaults do not match the post-migration shape');
        if (!constraintDefinitionMatches) reasons.push(`constraint definition mismatch on: ${constraintDefMismatches.join(', ')}`);
        if (!fkIsRestrict) reasons.push('invoices_company_id_fkey is not exactly "ON DELETE RESTRICT" under the expected name');
        stop(`all target object names exist, but the schema does not match MIGRATION_083 (${reasons.join('; ')}). Do not treat this as a completed migration; share the full output for review.`);
      }
    } else if (presentNewColumns.length > 0 || presentConstraints.length > 0 || sequencePresent) {
      stop('the migration appears partially applied or the schema overlaps with it. Do not run it as-is; share this output.');
    } else if (count.rows[0].n > 0) {
      stop('the table is not empty. The strict NOT NULL migration will fail on the new columns; a different migration must be written after reviewing these rows.');
    } else if (!legacyShapeMatches) {
      stop('the existing invoice columns do not match the pre-migration shape assumed by MIGRATION_083. Review the column table above before running it.');
    } else if (!fkIsCascade) {
      stop(`the company_id foreign key must be named "${EXPECTED_COMPANY_FK_NAME}" and use ON DELETE CASCADE before this migration runs.`);
    } else {
      console.log('\n>>> Preflight passed: the table is empty, target objects are absent, and no duplicate-period rows exist. MIGRATION_083 is structurally applicable; it has not been executed by this check.');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Preflight check failed:', err.message);
  process.exitCode = 1;
});
