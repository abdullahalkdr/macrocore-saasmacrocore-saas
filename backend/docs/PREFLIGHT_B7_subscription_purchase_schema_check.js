#!/usr/bin/env node
// Read-only preflight for MIGRATION_086 (Stage B7 — trial-to-paid customer
// self-service subscription checkout; see
// claude/chat7a-b7-customer-subscription-checkout-design-pass-v3-2026-09-24.md
// §10). This script is intentionally allowed to inspect a real database: it
// issues SELECT statements only and never reads or changes application
// environment files. Mirrors docs/PREFLIGHT_B6_payment_simulator_schema_check.js.
//
// It STOPS (exit code 2) unless ALL of the following hold:
//   1. MIGRATION_085 is present exactly: invoices_status_valid = ('issued','paid'),
//      invoices_payment_date_consistency, payment_checkout_sessions + its guard
//      trigger, 4-state payment_attempts_status_valid.
//   2. Zero subscriptions rows with a NULL status.
//   3. Every existing subscriptions.status is within {active, past_due, cancelled}.
//   4. Every existing invoices.status is within {issued, paid}.
//   5. No pre-existing user (non-internal) trigger on subscriptions or invoices —
//      a production-only trigger that stamps e.g. updated_at would conflict with
//      the new immutability guard.
//   6. No MIGRATION_086 artifact already exists (constraint, 3 functions,
//      3 triggers, table, index) — a partial/prior application must STOP.
//
// It also prints the controlled B6 QA records (read-only) so their values can
// be compared before and after the migration. They are never modified.
//
// PowerShell:
//   $env:DATABASE_URL = '<connection string>'
//   node docs/PREFLIGHT_B7_subscription_purchase_schema_check.js

const { Client } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');

const ALLOWED_EXISTING_SUBSCRIPTION_STATUSES = ['active', 'past_due', 'cancelled'];
const ALLOWED_EXISTING_INVOICE_STATUSES = ['issued', 'paid'];
const TARGET_FUNCTIONS = [
  'subscriptions_guard_pending',
  'invoices_guard_status_transition',
  'subscription_purchases_guard_mutation',
];
const TARGET_TRIGGERS = [
  'subscriptions_guard_pending_trg',
  'invoices_guard_status_transition_trg',
  'subscription_purchases_guard_mutation_trg',
];
const TARGET_TABLE = 'subscription_purchases';
const TARGET_INDEX = 'subscription_purchases_one_open_per_company';
const TARGET_SUBSCRIPTIONS_CONSTRAINT = 'subscriptions_status_valid';

// Controlled B6 QA records — printed read-only for before/after comparison.
const QA_SUBSCRIPTION_ID = '8ad8846e-0288-4a76-9714-2257ff349ba7';
const QA_INVOICE_ID = 'db26d277-89ee-41aa-bb32-ee16562317b9';

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
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

    const regclass = async (name) =>
      (await client.query(`SELECT to_regclass(format('%I.%I', current_schema(), $1::text))::text AS relation`, [name])).rows[0]?.relation || null;

    for (const table of ['companies', 'subscriptions', 'invoices', 'payment_attempts', 'payment_checkout_sessions']) {
      if (!(await regclass(table))) {
        console.log(`\n>>> STOP: table ${table} was not found in current_schema(). Is MIGRATION_085 applied?`);
        process.exitCode = 2;
        return;
      }
    }

    const constraintsOf = async (table) =>
      (
        await client.query(
          `SELECT conname, pg_get_constraintdef(c.oid) AS definition
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           WHERE n.nspname = current_schema() AND t.relname = $1
           ORDER BY conname`,
          [table]
        )
      ).rows;

    const invoicesConstraints = await constraintsOf('invoices');
    const subscriptionsConstraints = await constraintsOf('subscriptions');
    const attemptsConstraints = await constraintsOf('payment_attempts');
    console.log('\n=== invoices: current constraints ===');
    console.table(invoicesConstraints);
    console.log('\n=== subscriptions: current constraints ===');
    console.table(subscriptionsConstraints);

    const byName = (rows) => new Map(rows.map((r) => [r.conname, normalizeDef(r.definition)]));
    const invoicesByName = byName(invoicesConstraints);
    const attemptsByName = byName(attemptsConstraints);
    const subscriptionsByName = byName(subscriptionsConstraints);

    // --- 1. MIGRATION_085 present exactly.
    const invoiceStatusDef = invoicesByName.get('invoices_status_valid') || '';
    const invoiceStatusIs085 =
      invoiceStatusDef.includes("'issued'") && invoiceStatusDef.includes("'paid'") && !invoiceStatusDef.includes("'void'");
    const paymentDateConsistencyPresent = invoicesByName.has('invoices_payment_date_consistency');
    const attemptStatusDef = attemptsByName.get('payment_attempts_status_valid') || '';
    const attemptStatusIs085 = ["'initiated'", "'failed'", "'succeeded'", "'cancelled'"].every((v) => attemptStatusDef.includes(v));
    const sessionsTriggerPresent =
      (
        await client.query(
          `SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = current_schema() AND c.relname = 'payment_checkout_sessions'
             AND tg.tgname = 'payment_checkout_sessions_guard_mutation_trg' AND NOT tg.tgisinternal`
        )
      ).rows.length === 1;
    const migration085Present = invoiceStatusIs085 && paymentDateConsistencyPresent && attemptStatusIs085 && sessionsTriggerPresent;
    console.log(
      `\n=== MIGRATION_085 prerequisite: invoices_status_valid=${invoiceStatusDef || '(missing)'}, payment_date_consistency=${paymentDateConsistencyPresent}, 4-state attempts=${attemptStatusIs085}, sessions guard trigger=${sessionsTriggerPresent} ===`
    );

    // --- 2/3. subscriptions.status values.
    const subStatuses = (
      await client.query(`SELECT status, count(*)::int AS n FROM subscriptions GROUP BY status ORDER BY status NULLS FIRST`)
    ).rows;
    console.log('\n=== subscriptions.status distribution ===');
    console.table(subStatuses);
    const nullSubStatusCount = subStatuses.filter((r) => r.status === null).reduce((a, r) => a + r.n, 0);
    const unexpectedSubStatuses = subStatuses
      .filter((r) => r.status !== null && !ALLOWED_EXISTING_SUBSCRIPTION_STATUSES.includes(r.status))
      .map((r) => `${r.status} (${r.n})`);
    const statusColumn = (
      await client.query(
        `SELECT is_nullable, column_default FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'subscriptions' AND column_name = 'status'`
      )
    ).rows[0];
    console.log(`\n=== subscriptions.status column: is_nullable=${statusColumn?.is_nullable}, default=${statusColumn?.column_default} ===`);

    // --- 4. invoices.status values.
    const invStatuses = (
      await client.query(`SELECT status, count(*)::int AS n FROM invoices GROUP BY status ORDER BY status NULLS FIRST`)
    ).rows;
    console.log('\n=== invoices.status distribution ===');
    console.table(invStatuses);
    const unexpectedInvoiceStatuses = invStatuses
      .filter((r) => !ALLOWED_EXISTING_INVOICE_STATUSES.includes(r.status))
      .map((r) => `${r.status} (${r.n})`);

    // --- 5. No pre-existing user trigger on subscriptions/invoices.
    const existingTriggers = (
      await client.query(
        `SELECT c.relname AS table_name, tg.tgname AS trigger_name
         FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relname IN ('subscriptions', 'invoices') AND NOT tg.tgisinternal
         ORDER BY 1, 2`
      )
    ).rows;
    const foreignTriggers = existingTriggers.filter((r) => !TARGET_TRIGGERS.includes(r.trigger_name));
    console.log('\n=== user triggers on subscriptions/invoices ===');
    console.table(existingTriggers);

    // --- 6. Absence of every MIGRATION_086 artifact.
    const presentFunctions = (
      await client.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = current_schema() AND p.proname = ANY($1::text[])`,
        [TARGET_FUNCTIONS]
      )
    ).rows.map((r) => r.proname);
    const presentTriggers = existingTriggers
      .map((r) => r.trigger_name)
      .concat(
        (
          await client.query(
            `SELECT tg.tgname FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema() AND c.relname = $1 AND NOT tg.tgisinternal`,
            [TARGET_TABLE]
          ).catch(() => ({ rows: [] }))
        ).rows.map((r) => r.tgname)
      )
      .filter((name) => TARGET_TRIGGERS.includes(name));
    const tablePresent = !!(await regclass(TARGET_TABLE));
    const indexPresent = (
      await client.query(`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`, [TARGET_INDEX])
    ).rows.length > 0;
    const constraintPresent = subscriptionsByName.has(TARGET_SUBSCRIPTIONS_CONSTRAINT);
    const invoiceVoidAlreadyAllowed = invoiceStatusDef.includes("'void'");
    const anyTargetArtifactPresent =
      presentFunctions.length > 0 || presentTriggers.length > 0 || tablePresent || indexPresent || constraintPresent || invoiceVoidAlreadyAllowed;
    console.log(
      `\n=== MIGRATION_086 artifacts already present: functions=[${presentFunctions.join(', ') || 'none'}], triggers=[${presentTriggers.join(', ') || 'none'}], table=${tablePresent}, index=${indexPresent}, subscriptions_status_valid=${constraintPresent}, invoices 'void' allowed=${invoiceVoidAlreadyAllowed} ===`
    );

    // --- Read-only QA record print (never modified).
    const qaSub = (
      await client.query(
        `SELECT id, company_id, plan, status, currency, period_amount::text AS period_amount, billing_interval,
                current_period_start, current_period_end
         FROM subscriptions WHERE id = $1`,
        [QA_SUBSCRIPTION_ID]
      )
    ).rows;
    const qaInv = (
      await client.query(
        `SELECT id, invoice_number, company_id, subscription_id, status, amount::text AS amount, currency, payment_date
         FROM invoices WHERE id = $1`,
        [QA_INVOICE_ID]
      )
    ).rows;
    console.log('\n=== controlled QA subscription (read-only) ===');
    console.table(qaSub);
    console.log('\n=== controlled QA invoice (read-only) ===');
    console.table(qaInv);

    const stop = (message) => {
      console.log(`\n>>> STOP: ${message}`);
      process.exitCode = 2;
    };

    if (anyTargetArtifactPresent) {
      stop('one or more, but not necessarily all, MIGRATION_086 target artifacts already exist. Do not run it as-is; share this output for review.');
    } else if (!migration085Present) {
      stop('MIGRATION_085 is not present exactly as reviewed on this database. Apply/verify 085 first; do not run 086.');
    } else if (nullSubStatusCount > 0) {
      stop(`subscriptions has ${nullSubStatusCount} row(s) with a NULL status — ALTER COLUMN status SET NOT NULL would fail. Review before proceeding.`);
    } else if (unexpectedSubStatuses.length > 0) {
      stop(`subscriptions has status value(s) outside {active, past_due, cancelled}: ${unexpectedSubStatuses.join(', ')}. The new CHECK would fail. Review before proceeding.`);
    } else if (unexpectedInvoiceStatuses.length > 0) {
      stop(`invoices has status value(s) outside {issued, paid}: ${unexpectedInvoiceStatuses.join(', ')}. Review before proceeding.`);
    } else if (foreignTriggers.length > 0) {
      stop(
        `pre-existing user trigger(s) on subscriptions/invoices: ${foreignTriggers
          .map((r) => `${r.table_name}.${r.trigger_name}`)
          .join(', ')}. They could conflict with MIGRATION_086's new guard triggers. Review before proceeding.`
      );
    } else {
      console.log(
        '\n>>> Preflight passed: MIGRATION_085 is present exactly, subscriptions.status has no NULL/unknown values, invoices.status is within {issued, paid}, no foreign trigger exists on subscriptions/invoices, and no MIGRATION_086 target artifact already exists. MIGRATION_086 is structurally applicable; it has not been executed by this check.'
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Preflight check failed:', err.message);
  process.exitCode = 1;
});
