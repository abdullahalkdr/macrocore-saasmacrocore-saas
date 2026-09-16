#!/usr/bin/env node
// Read-only preflight for MIGRATION_084. This script is intentionally allowed
// to inspect a real database: it issues SELECT statements only and never
// reads or changes application environment files. Mirrors the structure of
// docs/PREFLIGHT_B3_invoices_schema_check.js.
//
// PowerShell:
//   $env:DATABASE_URL = '<connection string>'
//   node docs/PREFLIGHT_B5_payment_attempts_schema_check.js

const { Client } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');

const EXPECTED_SUBSCRIPTION_ID_FK_NAME = 'invoices_subscription_id_fkey';

const TARGET_NEW_CONSTRAINTS = [
  'subscriptions_id_company_id_unique',
  'invoices_subscription_company_fk',
  'invoices_id_company_subscription_unique',
];
const TARGET_PAYMENT_ATTEMPTS_OBJECTS = {
  table: 'payment_attempts',
  indexes: ['payment_attempts_one_active_per_invoice', 'payment_attempts_invoice_id_idx'],
  function: 'payment_attempts_guard_mutation',
  trigger: 'payment_attempts_guard_mutation_trg',
};
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
    const invoicesTable = await client.query(
      `SELECT to_regclass(format('%I.%I', current_schema(), 'invoices'))::text AS relation`
    );
    const subscriptionsTable = await client.query(
      `SELECT to_regclass(format('%I.%I', current_schema(), 'subscriptions'))::text AS relation`
    );
    if (!invoicesTable.rows[0]?.relation) throw new Error('invoices table was not found in current_schema()');
    if (!subscriptionsTable.rows[0]?.relation) throw new Error('subscriptions table was not found in current_schema()');

    const paymentAttemptsExists = await client.query(
      `SELECT to_regclass(format('%I.%I', current_schema(), 'payment_attempts'))::text AS relation`
    );

    const invoicesConstraints = await client.query(
      `SELECT conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = current_schema() AND t.relname = 'invoices'
       ORDER BY conname`
    );
    const subscriptionsConstraints = await client.query(
      `SELECT conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = current_schema() AND t.relname = 'subscriptions'
       ORDER BY conname`
    );
    const paymentAttemptsConstraints = await client.query(
      `SELECT conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = current_schema() AND t.relname = 'payment_attempts'
       ORDER BY conname`
    );

    console.log('\n=== invoices: current constraints ===');
    console.table(invoicesConstraints.rows);
    console.log('\n=== subscriptions: current constraints ===');
    console.table(subscriptionsConstraints.rows);
    console.log('\n=== payment_attempts: current constraints ===');
    console.table(paymentAttemptsConstraints.rows);
    console.log(`\n=== payment_attempts table already exists: ${!!paymentAttemptsExists.rows[0]?.relation} ===`);

    // --- 1. Confirm the exact live FK name/shape this migration is about to
    // DROP. MIGRATION_084 hardcodes the name "invoices_subscription_id_fkey"
    // (taken from MIGRATION_083's own trailing comment) — if the live name or
    // shape differs, STOP rather than let the DROP CONSTRAINT fail loudly (or
    // worse, silently drop the wrong thing if some other constraint happened
    // to share that name on a differently-evolved database).
    const subscriptionIdFk = invoicesConstraints.rows.find(
      (row) => row.definition.includes('FOREIGN KEY (subscription_id)') && !row.definition.includes('company_id')
    );
    console.log('\n=== invoices.subscription_id foreign key (current) ===');
    if (subscriptionIdFk) {
      console.log(`${subscriptionIdFk.conname}: ${subscriptionIdFk.definition}`);
    } else {
      console.log('(none)');
    }
    const fkNameMatches = subscriptionIdFk?.conname === EXPECTED_SUBSCRIPTION_ID_FK_NAME;
    const fkIsPlainNoAction = fkNameMatches && /^FOREIGN KEY \(subscription_id\) REFERENCES subscriptions\(id\)$/.test(subscriptionIdFk.definition.trim());

    // --- 2. The mismatch check Part A's new composite FK depends on: does
    // every existing invoice's own company_id already match the company_id
    // of the subscription it points to? If not, ADD CONSTRAINT
    // invoices_subscription_company_fk will fail validation against existing
    // rows (Postgres validates a new FK against existing data by default),
    // and — more importantly — a mismatch here means a real data problem
    // that must be reviewed manually before this migration ever runs.
    const mismatches = await client.query(
      `SELECT i.id AS invoice_id, i.company_id AS invoice_company_id, s.company_id AS subscription_company_id
       FROM invoices i
       JOIN subscriptions s ON s.id = i.subscription_id
       WHERE i.company_id IS DISTINCT FROM s.company_id`
    );
    console.log(`\n=== invoices whose company_id mismatches their own subscription's company_id: ${mismatches.rows.length} ===`);
    if (mismatches.rows.length) console.table(mismatches.rows);

    // --- 3. Confirm none of this migration's target objects already exist
    // (constraints, table, indexes, function, trigger) — a partial prior
    // application would be a reason to stop and review, not to re-run blindly.
    const constraintNames = new Set([
      ...invoicesConstraints.rows.map((r) => r.conname),
      ...subscriptionsConstraints.rows.map((r) => r.conname),
    ]);
    const presentNewConstraints = TARGET_NEW_CONSTRAINTS.filter((name) => constraintNames.has(name));

    const functionExists = await client.query(
      `SELECT p.oid::regprocedure::text AS proc, pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = current_schema() AND p.proname = $1 AND p.pronargs = 0`,
      [TARGET_PAYMENT_ATTEMPTS_OBJECTS.function]
    );
    const triggerExists = await client.query(
      `SELECT pg_get_triggerdef(tg.oid) AS definition, p.proname AS function_name,
              c.relname AS table_name
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = tg.tgfoid
       WHERE n.nspname = current_schema() AND tg.tgname = $1 AND NOT tg.tgisinternal`,
      [TARGET_PAYMENT_ATTEMPTS_OBJECTS.trigger]
    );
    const indexesExist = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[])`,
      [TARGET_PAYMENT_ATTEMPTS_OBJECTS.indexes]
    );

    const tableExists = !!paymentAttemptsExists.rows[0]?.relation;
    const functionPresent = !!functionExists.rows[0]?.proc;
    const triggerPresent = triggerExists.rows.length > 0;
    const allNewConstraintsPresent = presentNewConstraints.length === TARGET_NEW_CONSTRAINTS.length;
    const oldFkGone = !subscriptionIdFk;

    const anyPartial =
      presentNewConstraints.length > 0 ||
      tableExists ||
      functionPresent ||
      triggerPresent ||
      indexesExist.rows.length > 0;

    // Exact full-match success path (mirrors PREFLIGHT_B3's own "already
    // applied and matches — do not run it again" branch) — every target
    // object present, the old subscription_id-only FK gone, table shape as
    // expected. Anything less than ALL of these present is treated as
    // partial/mismatched below, never as "close enough."
    const columns = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default,
              character_maximum_length, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'payment_attempts'
       ORDER BY ordinal_position`
    );
    const columnsByName = new Map(columns.rows.map((r) => [r.column_name, r]));
    const expectedColumns = [
      'id', 'invoice_id', 'company_id', 'subscription_id', 'amount', 'currency', 'plan',
      'billing_interval', 'period_start', 'period_end', 'idempotency_key', 'status',
      'created_at', 'failed_at',
    ];
    const columnIs = (name, type, nullable, options = {}) => {
      const col = columnsByName.get(name);
      if (!col || col.data_type !== type || col.is_nullable !== nullable) return false;
      if (options.length !== undefined && col.character_maximum_length !== options.length) return false;
      if (options.precision !== undefined && col.numeric_precision !== options.precision) return false;
      if (options.scale !== undefined && col.numeric_scale !== options.scale) return false;
      if (options.defaultIncludes !== undefined && !(col.column_default || '').includes(options.defaultIncludes)) return false;
      if (options.noDefault && col.column_default !== null) return false;
      return true;
    };
    const columnsMatch = tableExists && columns.rows.length === expectedColumns.length &&
      columnIs('id', 'uuid', 'NO', { defaultIncludes: 'gen_random_uuid' }) &&
      columnIs('invoice_id', 'uuid', 'NO', { noDefault: true }) &&
      columnIs('company_id', 'uuid', 'NO', { noDefault: true }) &&
      columnIs('subscription_id', 'uuid', 'NO', { noDefault: true }) &&
      columnIs('amount', 'numeric', 'NO', { precision: 10, scale: 3, noDefault: true }) &&
      columnIs('currency', 'character varying', 'NO', { length: 3, noDefault: true }) &&
      columnIs('plan', 'character varying', 'NO', { length: 20, noDefault: true }) &&
      columnIs('billing_interval', 'character varying', 'NO', { length: 10, noDefault: true }) &&
      columnIs('period_start', 'timestamp with time zone', 'NO', { noDefault: true }) &&
      columnIs('period_end', 'timestamp with time zone', 'NO', { noDefault: true }) &&
      columnIs('idempotency_key', 'character varying', 'NO', { length: 100, noDefault: true }) &&
      columnIs('status', 'character varying', 'NO', { length: 20, defaultIncludes: 'initiated' }) &&
      columnIs('created_at', 'timestamp with time zone', 'NO', { defaultIncludes: 'now()' }) &&
      columnIs('failed_at', 'timestamp with time zone', 'YES', { noDefault: true });

    const normalizeDef = (definition) => (definition || '').replace(/\s+/g, ' ').trim();
    const allConstraintsByName = new Map([
      ...invoicesConstraints.rows,
      ...subscriptionsConstraints.rows,
      ...paymentAttemptsConstraints.rows,
    ].map((row) => [row.conname, normalizeDef(row.definition)]));
    const exactConstraintDefinitionsMatch =
      allConstraintsByName.get('subscriptions_id_company_id_unique') === 'UNIQUE (id, company_id)' &&
      allConstraintsByName.get('invoices_subscription_company_fk') ===
        'FOREIGN KEY (subscription_id, company_id) REFERENCES subscriptions(id, company_id) ON DELETE RESTRICT' &&
      allConstraintsByName.get('invoices_id_company_subscription_unique') ===
        'UNIQUE (id, company_id, subscription_id)' &&
      allConstraintsByName.get('payment_attempts_pkey') === 'PRIMARY KEY (id)' &&
      allConstraintsByName.get('payment_attempts_invoice_company_subscription_fk') ===
        'FOREIGN KEY (invoice_id, company_id, subscription_id) REFERENCES invoices(id, company_id, subscription_id) ON DELETE RESTRICT' &&
      allConstraintsByName.get('payment_attempts_idempotency_key_unique') === 'UNIQUE (idempotency_key)';
    const paymentConstraintNames = new Set(paymentAttemptsConstraints.rows.map((row) => row.conname));
    const allPaymentConstraintsPresent = TARGET_PAYMENT_ATTEMPTS_CONSTRAINTS.every((name) => paymentConstraintNames.has(name));
    const checkDefHas = (name, fragments) => {
      const definition = allConstraintsByName.get(name) || '';
      return fragments.every((fragment) => definition.includes(fragment));
    };
    const checkConstraintDefinitionsMatch =
      checkDefHas('payment_attempts_amount_positive', ['amount >', '(0)::numeric']) &&
      checkDefHas('payment_attempts_currency_supported', ['currency', "'USD'", "'KWD'"]) &&
      checkDefHas('payment_attempts_billing_interval_valid', ['billing_interval', "'monthly'", "'annual'"]) &&
      checkDefHas('payment_attempts_period_end_after_start', ['period_end > period_start']) &&
      checkDefHas('payment_attempts_status_valid', ['status', "'initiated'", "'failed'"]) &&
      checkDefHas('payment_attempts_failed_at_consistency', ['status', "'failed'", 'failed_at IS NOT NULL']) &&
      checkDefHas('payment_attempts_idempotency_key_normalized', [
        'idempotency_key', 'btrim', 'char_length', '>= 1', '<= 100',
      ]);

    const indexesByName = new Map(indexesExist.rows.map((row) => [row.indexname, normalizeDef(row.indexdef)]));
    const activeIndexDef = indexesByName.get('payment_attempts_one_active_per_invoice') || '';
    const invoiceIndexDef = indexesByName.get('payment_attempts_invoice_id_idx') || '';
    const indexesMatch =
      activeIndexDef.startsWith('CREATE UNIQUE INDEX ') &&
      activeIndexDef.includes(' ON public.payment_attempts USING btree (invoice_id)') &&
      activeIndexDef.includes("WHERE ((status)::text = 'initiated'::text)") &&
      invoiceIndexDef.startsWith('CREATE INDEX ') &&
      invoiceIndexDef.includes(' ON public.payment_attempts USING btree (invoice_id)') &&
      !invoiceIndexDef.includes(' WHERE ');

    const functionDefinition = functionExists.rows[0]?.definition || '';
    const functionFragments = [
      "TG_OP = 'INSERT'", "NEW.status <> 'initiated'", 'NEW.failed_at IS NOT NULL',
      "TG_OP = 'DELETE'", 'NEW.id', 'NEW.invoice_id', 'NEW.company_id',
      'NEW.subscription_id', 'NEW.amount', 'NEW.currency', 'NEW.plan',
      'NEW.billing_interval', 'NEW.period_start', 'NEW.period_end',
      'NEW.idempotency_key', 'NEW.created_at',
      "OLD.status = 'initiated'", "NEW.status = 'failed'", 'NEW.failed_at := now()',
    ];
    const functionMatches = functionPresent && functionFragments.every((fragment) => functionDefinition.includes(fragment));
    const triggerDefinition = triggerExists.rows[0]?.definition || '';
    const triggerMatches = triggerPresent &&
      triggerExists.rows[0].table_name === 'payment_attempts' &&
      triggerExists.rows[0].function_name === TARGET_PAYMENT_ATTEMPTS_OBJECTS.function &&
      triggerDefinition.includes('BEFORE') && triggerDefinition.includes('INSERT') && triggerDefinition.includes('UPDATE') &&
      triggerDefinition.includes('DELETE') && triggerDefinition.includes('FOR EACH ROW');

    const fullyAppliedAndMatches =
      allNewConstraintsPresent && allPaymentConstraintsPresent && exactConstraintDefinitionsMatch &&
      checkConstraintDefinitionsMatch && columnsMatch && indexesMatch && functionMatches &&
      triggerMatches && oldFkGone;

    console.log(`\n=== target objects already present: constraints=[${presentNewConstraints.join(', ') || 'none'}], payment_attempt constraints=[${paymentAttemptsConstraints.rows.map((r) => r.conname).join(', ') || 'none'}], payment_attempts table=${tableExists}, function=${functionPresent}, trigger=${triggerPresent}, indexes=[${indexesExist.rows.map((r) => r.indexname).join(', ') || 'none'}] ===`);

    const stop = (message) => {
      console.log(`\n>>> STOP: ${message}`);
      process.exitCode = 2;
    };

    if (mismatches.rows.length) {
      stop('at least one invoice\'s company_id does not match its own subscription\'s company_id — the new composite foreign key cannot be added until these rows are reviewed manually.');
    } else if (fullyAppliedAndMatches) {
      console.log('\n>>> MIGRATION_084 is already applied and its constraints, table, indexes, function, and trigger match the expected shape. Do not run it again.');
    } else if (anyPartial) {
      stop('one or more, but not all, MIGRATION_084 target objects already exist. Do not run it as-is; share this output for review.');
    } else if (!fkNameMatches) {
      stop(`invoices.subscription_id's foreign key must be named "${EXPECTED_SUBSCRIPTION_ID_FK_NAME}" before this migration runs (found: ${subscriptionIdFk?.conname || '(none)'}).`);
    } else if (!fkIsPlainNoAction) {
      stop(`invoices.subscription_id's foreign key must be a plain "REFERENCES subscriptions(id)" with no ON DELETE action before this migration runs (found: ${subscriptionIdFk.definition}). If it already carries an ON DELETE action, MIGRATION_084's DROP/ADD sequence would silently change that behavior — review before proceeding.`);
    } else {
      console.log('\n>>> Preflight passed: no company_id/subscription_id mismatches exist, the current invoices_subscription_id_fkey matches the exact name and shape MIGRATION_084 assumes, and no target object from this migration already exists. MIGRATION_084 is structurally applicable; it has not been executed by this check.');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Preflight check failed:', err.message);
  process.exitCode = 1;
});
