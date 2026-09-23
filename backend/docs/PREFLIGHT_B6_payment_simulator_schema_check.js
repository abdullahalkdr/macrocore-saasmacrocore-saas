#!/usr/bin/env node
// Read-only preflight for MIGRATION_085. This script is intentionally allowed
// to inspect a real database: it issues SELECT statements only and never
// reads or changes application environment files. Mirrors the structure of
// docs/PREFLIGHT_B5_payment_attempts_schema_check.js.
//
// PowerShell:
//   $env:DATABASE_URL = '<connection string>'
//   node docs/PREFLIGHT_B6_payment_simulator_schema_check.js

const { Client } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');

const TARGET_PAYMENT_ATTEMPTS_CONSTRAINTS = [
  'payment_attempts_pkey',
  'payment_attempts_invoice_company_subscription_fk',
  'payment_attempts_amount_positive',
  'payment_attempts_currency_supported',
  'payment_attempts_billing_interval_valid',
  'payment_attempts_period_end_after_start',
  'payment_attempts_status_valid',
  'payment_attempts_failed_at_consistency',
  'payment_attempts_idempotency_key_normalized',
  'payment_attempts_idempotency_key_unique',
];
const TARGET_NEW_PAYMENT_ATTEMPTS_CONSTRAINTS = [
  'payment_attempts_succeeded_at_consistency',
  'payment_attempts_cancelled_at_consistency',
];
const TARGET_NEW_INVOICES_CONSTRAINTS = ['invoices_payment_date_consistency'];
const TARGET_NEW_COLUMNS = ['succeeded_at', 'cancelled_at'];
const TARGET_NEW_TABLE = 'payment_checkout_sessions';
const TARGET_NEW_TABLE_FUNCTION = 'payment_checkout_sessions_guard_mutation';
const TARGET_NEW_TABLE_TRIGGER = 'payment_checkout_sessions_guard_mutation_trg';
const REQUIRED_B5_INDEXES = ['payment_attempts_one_active_per_invoice', 'payment_attempts_invoice_id_idx'];

const normalizeDef = (definition) => (definition || '').replace(/\s+/g, ' ').trim();

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
    const paymentAttemptsTable = await client.query(
      `SELECT to_regclass(format('%I.%I', current_schema(), 'payment_attempts'))::text AS relation`
    );
    const invoicesTable = await client.query(
      `SELECT to_regclass(format('%I.%I', current_schema(), 'invoices'))::text AS relation`
    );
    if (!paymentAttemptsTable.rows[0]?.relation) throw new Error('payment_attempts table was not found in current_schema() — is MIGRATION_084 applied?');
    if (!invoicesTable.rows[0]?.relation) throw new Error('invoices table was not found in current_schema()');

    const sessionsTableExists = await client.query(
      `SELECT to_regclass(format('%I.%I', current_schema(), 'payment_checkout_sessions'))::text AS relation`
    );

    const paymentAttemptsConstraints = await client.query(
      `SELECT conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = current_schema() AND t.relname = 'payment_attempts'
       ORDER BY conname`
    );
    const invoicesConstraints = await client.query(
      `SELECT conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = current_schema() AND t.relname = 'invoices'
       ORDER BY conname`
    );
    const paymentAttemptsIndexes = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [REQUIRED_B5_INDEXES]
    );

    console.log('\n=== payment_attempts: current constraints ===');
    console.table(paymentAttemptsConstraints.rows);
    console.log('\n=== invoices: current constraints ===');
    console.table(invoicesConstraints.rows);
    console.log(`\n=== payment_checkout_sessions table already exists: ${!!sessionsTableExists.rows[0]?.relation} ===`);

    // --- 1. Every existing B5 constraint by exact name is present, unchanged.
    const paymentAttemptsConstraintNames = new Set(paymentAttemptsConstraints.rows.map((r) => r.conname));
    const allExistingB5ConstraintsPresent = TARGET_PAYMENT_ATTEMPTS_CONSTRAINTS.every((name) => paymentAttemptsConstraintNames.has(name));
    const missingB5Constraints = TARGET_PAYMENT_ATTEMPTS_CONSTRAINTS.filter((name) => !paymentAttemptsConstraintNames.has(name));
    const paymentAttemptsConstraintsByName = new Map(
      paymentAttemptsConstraints.rows.map((row) => [row.conname, normalizeDef(row.definition)])
    );
    const checkDefHas = (name, fragments) => {
      const definition = paymentAttemptsConstraintsByName.get(name) || '';
      return fragments.every((fragment) => definition.includes(fragment));
    };
    const exactB5ConstraintDefinitionsMatch =
      paymentAttemptsConstraintsByName.get('payment_attempts_pkey') === 'PRIMARY KEY (id)' &&
      paymentAttemptsConstraintsByName.get('payment_attempts_invoice_company_subscription_fk') ===
        'FOREIGN KEY (invoice_id, company_id, subscription_id) REFERENCES invoices(id, company_id, subscription_id) ON DELETE RESTRICT' &&
      paymentAttemptsConstraintsByName.get('payment_attempts_idempotency_key_unique') === 'UNIQUE (idempotency_key)' &&
      checkDefHas('payment_attempts_amount_positive', ['amount >', '(0)::numeric']) &&
      checkDefHas('payment_attempts_currency_supported', ['currency', "'USD'", "'KWD'"]) &&
      checkDefHas('payment_attempts_billing_interval_valid', ['billing_interval', "'monthly'", "'annual'"]) &&
      checkDefHas('payment_attempts_period_end_after_start', ['period_end > period_start']) &&
      checkDefHas('payment_attempts_status_valid', ['status', "'initiated'", "'failed'"]) &&
      !checkDefHas('payment_attempts_status_valid', ["'succeeded'"]) &&
      !checkDefHas('payment_attempts_status_valid', ["'cancelled'"]) &&
      checkDefHas('payment_attempts_failed_at_consistency', ['status', "'failed'", 'failed_at IS NOT NULL']) &&
      checkDefHas('payment_attempts_idempotency_key_normalized', [
        'idempotency_key', 'btrim', 'char_length', '>= 1', '<= 100',
      ]);

    const indexesByName = new Map(
      paymentAttemptsIndexes.rows.map((row) => [row.indexname, normalizeDef(row.indexdef)])
    );
    const activeIndexDef = indexesByName.get('payment_attempts_one_active_per_invoice') || '';
    const invoiceIndexDef = indexesByName.get('payment_attempts_invoice_id_idx') || '';
    const exactB5IndexesMatch =
      paymentAttemptsIndexes.rows.length === REQUIRED_B5_INDEXES.length &&
      activeIndexDef.startsWith('CREATE UNIQUE INDEX ') &&
      activeIndexDef.includes(' ON public.payment_attempts USING btree (invoice_id)') &&
      activeIndexDef.includes("WHERE ((status)::text = 'initiated'::text)") &&
      invoiceIndexDef.startsWith('CREATE INDEX ') &&
      invoiceIndexDef.includes(' ON public.payment_attempts USING btree (invoice_id)') &&
      !invoiceIndexDef.includes(' WHERE ');

    // --- 2. The existing function/trigger (payment_attempts_guard_mutation /
    // payment_attempts_guard_mutation_trg) exists — captured verbatim so
    // MIGRATION_085's own CREATE OR REPLACE FUNCTION can be diffed against
    // this exact "before" text, never guessed at.
    const functionBefore = await client.query(
      `SELECT p.oid::regprocedure::text AS proc, pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = current_schema() AND p.proname = 'payment_attempts_guard_mutation' AND p.pronargs = 0`
    );
    const triggerBefore = await client.query(
      `SELECT pg_get_triggerdef(tg.oid) AS definition, p.proname AS function_name, c.relname AS table_name
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = tg.tgfoid
       WHERE n.nspname = current_schema() AND tg.tgname = 'payment_attempts_guard_mutation_trg' AND NOT tg.tgisinternal`
    );
    const functionExistsBefore = !!functionBefore.rows[0]?.proc;
    const triggerExistsBefore = triggerBefore.rows.length > 0;
    console.log(`\n=== payment_attempts_guard_mutation() exists: ${functionExistsBefore}, payment_attempts_guard_mutation_trg exists: ${triggerExistsBefore} ===`);
    if (functionExistsBefore) {
      console.log('\n--- current function body (this is what MIGRATION_085 extends) ---');
      console.log(functionBefore.rows[0].definition);
    }
    // The pre-migration function must NOT already mention 'succeeded' or
    // 'cancelled' transitions — if it does, this migration (or something
    // equivalent) has already partially landed.
    const functionAlreadyExtended = functionExistsBefore &&
      (functionBefore.rows[0].definition.includes("NEW.status = 'succeeded'") ||
       functionBefore.rows[0].definition.includes("NEW.status = 'cancelled'"));
    const functionDefinitionBefore = functionBefore.rows[0]?.definition || '';
    const expectedB5FunctionFragments = [
      "TG_OP = 'INSERT'", "NEW.status <> 'initiated'", 'NEW.failed_at IS NOT NULL',
      "TG_OP = 'DELETE'", 'NEW.id', 'NEW.invoice_id', 'NEW.company_id',
      'NEW.subscription_id', 'NEW.amount', 'NEW.currency', 'NEW.plan',
      'NEW.billing_interval', 'NEW.period_start', 'NEW.period_end',
      'NEW.idempotency_key', 'NEW.created_at',
      "OLD.status = 'initiated'", "NEW.status = 'failed'", 'NEW.failed_at := now()',
    ];
    const b5FunctionMatches = functionExistsBefore &&
      expectedB5FunctionFragments.every((fragment) => functionDefinitionBefore.includes(fragment)) &&
      !functionAlreadyExtended;
    const triggerDefinitionBefore = triggerBefore.rows[0]?.definition || '';
    const b5TriggerMatches = triggerExistsBefore &&
      triggerBefore.rows[0].table_name === 'payment_attempts' &&
      triggerBefore.rows[0].function_name === 'payment_attempts_guard_mutation' &&
      triggerDefinitionBefore.includes('BEFORE') && triggerDefinitionBefore.includes('INSERT') &&
      triggerDefinitionBefore.includes('UPDATE') && triggerDefinitionBefore.includes('DELETE') &&
      triggerDefinitionBefore.includes('FOR EACH ROW');

    // --- 3. invoices.payment_date's current type is exactly `timestamp
    // without time zone` (i.e. not yet converted), and every existing row
    // has it NULL — the literal proof the pure type-widening ALTER is
    // lossless.
    const paymentDateColumn = await client.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'invoices' AND column_name = 'payment_date'`
    );
    const paymentDateType = paymentDateColumn.rows[0]?.data_type || null;
    const paymentDateIsTimestampNoTz = paymentDateType === 'timestamp without time zone';
    const paymentDateIsAlreadyTz = paymentDateType === 'timestamp with time zone';
    const paymentDateNotNullCount = await client.query(
      `SELECT count(*)::int AS n FROM invoices WHERE payment_date IS NOT NULL`
    );
    const paymentDateAllNull = paymentDateNotNullCount.rows[0].n === 0;
    console.log(`\n=== invoices.payment_date current type: ${paymentDateType}, non-NULL rows: ${paymentDateNotNullCount.rows[0].n} ===`);

    // invoices_status_valid's current definition — must still be the
    // narrow, B3-era CHECK (status IN ('issued')) before this migration
    // widens it to ('issued', 'paid').
    const invoicesConstraintsByName = new Map(invoicesConstraints.rows.map((r) => [r.conname, (r.definition || '').replace(/\s+/g, ' ').trim()]));
    const statusValidDef = invoicesConstraintsByName.get('invoices_status_valid') || '';
    const statusValidIsNarrow = statusValidDef === "CHECK (((status)::text = 'issued'::text))";
    const statusValidAlreadyWidened = statusValidDef.includes("'issued'") && statusValidDef.includes("'paid'");
    console.log(`\n=== invoices_status_valid current definition: ${statusValidDef || '(missing)'} ===`);

    // Sanity: no payment_attempts row can yet have status NOT IN
    // ('initiated','failed') — those values don't exist until this
    // migration adds them.
    const preExistingWideStatusCount = await client.query(
      `SELECT count(*)::int AS n FROM payment_attempts WHERE status NOT IN ('initiated', 'failed')`
    );
    console.log(`\n=== payment_attempts rows with a status outside ('initiated','failed') today: ${preExistingWideStatusCount.rows[0].n} ===`);

    // --- 4. Absence of every MIGRATION_085 target artifact.
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'payment_attempts' AND column_name = ANY($1::text[])`,
      [TARGET_NEW_COLUMNS]
    );
    const presentNewColumns = columns.rows.map((r) => r.column_name);
    const presentNewPaymentAttemptsConstraints = TARGET_NEW_PAYMENT_ATTEMPTS_CONSTRAINTS.filter((name) => paymentAttemptsConstraintNames.has(name));
    const invoicesConstraintNames = new Set(invoicesConstraints.rows.map((r) => r.conname));
    const presentNewInvoicesConstraints = TARGET_NEW_INVOICES_CONSTRAINTS.filter((name) => invoicesConstraintNames.has(name));
    const sessionsTablePresent = !!sessionsTableExists.rows[0]?.relation;
    const targetFunctionExists = await client.query(
      `SELECT p.oid::regprocedure::text AS proc
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = current_schema() AND p.proname = $1 AND p.pronargs = 0`,
      [TARGET_NEW_TABLE_FUNCTION]
    );
    const targetTriggerExists = await client.query(
      `SELECT tg.tgname
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND tg.tgname = $1 AND NOT tg.tgisinternal`,
      [TARGET_NEW_TABLE_TRIGGER]
    );
    const targetFunctionPresent = targetFunctionExists.rows.length > 0;
    const targetTriggerPresent = targetTriggerExists.rows.length > 0;

    const anyTargetArtifactPresent =
      presentNewColumns.length > 0 ||
      presentNewPaymentAttemptsConstraints.length > 0 ||
      presentNewInvoicesConstraints.length > 0 ||
      sessionsTablePresent ||
      targetFunctionPresent ||
      targetTriggerPresent ||
      functionAlreadyExtended ||
      statusValidAlreadyWidened ||
      paymentDateIsAlreadyTz;

    console.log(`\n=== B5 prerequisite shape: exact constraints=${exactB5ConstraintDefinitionsMatch}, exact indexes=${exactB5IndexesMatch}, guard function=${b5FunctionMatches}, guard trigger=${b5TriggerMatches} ===`);
    console.log(`\n=== target artifacts already present: columns=[${presentNewColumns.join(', ') || 'none'}], payment_attempts constraints=[${presentNewPaymentAttemptsConstraints.join(', ') || 'none'}], invoices constraints=[${presentNewInvoicesConstraints.join(', ') || 'none'}], payment_checkout_sessions table=${sessionsTablePresent}, target function=${targetFunctionPresent}, target trigger=${targetTriggerPresent}, function already extended=${functionAlreadyExtended}, invoices_status_valid already widened=${statusValidAlreadyWidened}, payment_date already timestamptz=${paymentDateIsAlreadyTz} ===`);

    const stop = (message) => {
      console.log(`\n>>> STOP: ${message}`);
      process.exitCode = 2;
    };

    if (!paymentDateAllNull) {
      stop(`invoices.payment_date has ${paymentDateNotNullCount.rows[0].n} non-NULL row(s) — the pure type-widening ALTER COLUMN ... TYPE TIMESTAMPTZ this migration performs (no USING clause) is only safe when this count is 0. Review before proceeding; do not run this migration unmodified.`);
    } else if (preExistingWideStatusCount.rows[0].n > 0) {
      stop(`payment_attempts already has ${preExistingWideStatusCount.rows[0].n} row(s) with a status outside ('initiated','failed') — that should be structurally impossible before this migration runs. Review before proceeding.`);
    } else if (missingB5Constraints.length > 0) {
      stop(`one or more existing B5 constraints on payment_attempts are missing: ${missingB5Constraints.join(', ')}. Is MIGRATION_084 fully applied on this database?`);
    } else if (!exactB5ConstraintDefinitionsMatch || !exactB5IndexesMatch || !b5FunctionMatches || !b5TriggerMatches) {
      stop(`the existing B5 payment_attempts foundation does not match the exact prerequisite shape MIGRATION_085 was reviewed against (constraints=${exactB5ConstraintDefinitionsMatch}, indexes=${exactB5IndexesMatch}, function=${b5FunctionMatches}, trigger=${b5TriggerMatches}). Review this database before proceeding.`);
    } else if (anyTargetArtifactPresent) {
      stop('one or more, but not necessarily all, MIGRATION_085 target artifacts already exist. Do not run it as-is; share this output for review.');
    } else if (!paymentDateIsTimestampNoTz) {
      stop(`invoices.payment_date's current type must be exactly "timestamp without time zone" before this migration runs (found: ${paymentDateType}).`);
    } else if (!statusValidIsNarrow) {
      stop(`invoices_status_valid's current definition must still be the narrow, B3-era CHECK before this migration runs (found: ${statusValidDef || '(missing)'}).`);
    } else if (!functionExistsBefore || !triggerExistsBefore) {
      stop(`payment_attempts_guard_mutation()/payment_attempts_guard_mutation_trg must already exist (from MIGRATION_084) before this migration runs (function present: ${functionExistsBefore}, trigger present: ${triggerExistsBefore}).`);
    } else {
      console.log('\n>>> Preflight passed: the existing B5 constraints/indexes/function/trigger match the reviewed prerequisite shape, invoices.payment_date is all-NULL and still timestamp-without-time-zone, invoices_status_valid is still narrow, and no MIGRATION_085 target artifact already exists. MIGRATION_085 is structurally applicable; it has not been executed by this check.');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Preflight check failed:', err.message);
  process.exitCode = 1;
});
