#!/usr/bin/env node
// Read-only preflight for MIGRATION_087 (Stage B8 — paid-to-paid self-service
// subscription upgrades; see
// claude/chat8a-b8-paid-subscription-upgrade-design-pass-v4-2026-09-24.md
// §10.3). It issues SELECT statements only, in a READ ONLY session, and never
// reads or changes application environment files. Mirrors
// docs/PREFLIGHT_B7_subscription_purchase_schema_check.js.
//
// It STOPS (exit code 2) unless ALL of the following hold:
//   1. MIGRATION_086 is present exactly: 5-value subscriptions_status_valid,
//      the subscriptions / invoices / subscription_purchases guard functions +
//      triggers, the subscription_purchases table, its one-open index, and the
//      purchase guard stamping with clock_timestamp().
//   2. No MIGRATION_087 artifact exists yet: 'superseded' in the CHECK, the
//      replaces_subscription_id column / FK / CHECK, the one-completed index,
//      or attempt/session guard functions already stamping clock_timestamp().
//   3. The deployed payment_attempts / payment_checkout_sessions guard function
//      bodies match MIGRATION_085's text (whitespace-normalised) — a
//      production-drifted body must be reviewed, never silently replaced.
//   4. DISTINCT subscriptions.status ⊆ {active, past_due, cancelled,
//      pending_payment, abandoned}.
//   5. subscriptions has exactly the 14 known columns (the 087 guard's
//      whole-row comparison depends on it).
//   6. No unknown user trigger on subscriptions / invoices /
//      subscription_purchases / payment_attempts / payment_checkout_sessions.
//   7. No company has more than one live (active / past_due) subscription.
//
// It also prints, read-only: live subscriptions by plan and interval, the
// companies.plan != live.plan count, active subscriptions with an issued
// invoice (decision O7 impact), open purchases, and the QA invoices
// MC-SUB-000006/7/8. Nothing is modified.
//
// The validation rules live in exported pure functions so the disposable-DB
// smoke (SMOKE_B8) can exercise them directly as well as run this script.
//
// PowerShell:
//   $env:DATABASE_URL = '<connection string>'
//   node docs/PREFLIGHT_B8_subscription_upgrade_schema_check.js

const fs = require('fs');
const path = require('path');

const ALLOWED_PRE_087_SUBSCRIPTION_STATUSES = ['active', 'past_due', 'cancelled', 'pending_payment', 'abandoned'];
const EXPECTED_SUBSCRIPTION_COLUMNS = [
  'id',
  'company_id',
  'plan',
  'status',
  'monthly_price',
  'auto_renew',
  'next_billing_date',
  'created_at',
  'updated_at',
  'currency',
  'billing_interval',
  'current_period_start',
  'current_period_end',
  'period_amount',
];
const KNOWN_TRIGGERS = {
  subscriptions: ['subscriptions_guard_pending_trg'],
  invoices: ['invoices_guard_status_transition_trg'],
  subscription_purchases: ['subscription_purchases_guard_mutation_trg'],
  payment_attempts: ['payment_attempts_guard_mutation_trg'],
  payment_checkout_sessions: ['payment_checkout_sessions_guard_mutation_trg'],
};
const QA_INVOICE_NUMBERS = ['MC-SUB-000006', 'MC-SUB-000007', 'MC-SUB-000008'];

const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();

/** Rule 4: returns the list of unexpected status values (empty = OK). */
function validateSubscriptionStatuses(statuses) {
  return statuses.filter((s) => s === null || !ALLOWED_PRE_087_SUBSCRIPTION_STATUSES.includes(s)).map((s) => String(s));
}

/** Rule 5: returns { missing, extra } column names (both empty = OK). */
function validateSubscriptionColumns(columns) {
  const got = new Set(columns);
  const want = new Set(EXPECTED_SUBSCRIPTION_COLUMNS);
  return {
    missing: EXPECTED_SUBSCRIPTION_COLUMNS.filter((c) => !got.has(c)),
    extra: columns.filter((c) => !want.has(c)),
  };
}

/** Extracts a plpgsql function body (the text between AS $$ and $$) from a migration file's text. */
function extractFunctionBody(sqlText, functionName) {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION ${functionName}\\(\\)[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$ LANGUAGE plpgsql`);
  const m = re.exec(sqlText);
  return m ? m[1] : null;
}

/**
 * Rule 3: compares deployed bodies (pg_proc.prosrc) with MIGRATION_085's text.
 * Returns the names whose body differs (empty = OK).
 */
function validateFunctionBodies(deployed, migration085Text) {
  const drifted = [];
  for (const name of ['payment_attempts_guard_mutation', 'payment_checkout_sessions_guard_mutation']) {
    const expected = extractFunctionBody(migration085Text, name);
    if (expected === null || normalize(deployed[name]) !== normalize(expected)) drifted.push(name);
  }
  return drifted;
}

async function main() {
  const { Client } = require('pg');
  const { parse: parseConnectionString } = require('pg-connection-string');
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
  const stops = [];
  const stop = (message) => stops.push(message);

  try {
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

    const regclass = async (name) =>
      (await client.query(`SELECT to_regclass(format('%I.%I', current_schema(), $1::text))::text AS relation`, [name])).rows[0]?.relation || null;
    for (const table of ['companies', 'subscriptions', 'invoices', 'payment_attempts', 'payment_checkout_sessions', 'subscription_purchases']) {
      if (!(await regclass(table))) {
        console.log(`\n>>> STOP: table ${table} was not found in current_schema(). Is MIGRATION_086 applied?`);
        process.exitCode = 2;
        return;
      }
    }

    const constraintDef = async (table, name) =>
      normalize(
        (
          await client.query(
            `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = current_schema() AND t.relname = $1 AND c.conname = $2`,
            [table, name]
          )
        ).rows[0]?.def
      );
    const prosrc = async (name) =>
      (
        await client.query(
          `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = current_schema() AND p.proname = $1`,
          [name]
        )
      ).rows[0]?.prosrc ?? null;
    const indexExists = async (name) =>
      (await client.query(`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`, [name])).rows.length > 0;
    const columnExists = async (table, column) =>
      (
        await client.query(
          `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
          [table, column]
        )
      ).rows.length > 0;

    // --- Triggers (rules 1 and 6).
    const triggers = (
      await client.query(
        `SELECT c.relname AS table_name, tg.tgname AS trigger_name
         FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[]) AND NOT tg.tgisinternal
         ORDER BY 1, 2`,
        [Object.keys(KNOWN_TRIGGERS)]
      )
    ).rows;
    console.log('\n=== user triggers on billing tables ===');
    console.table(triggers);
    const unknownTriggers = triggers.filter((r) => !(KNOWN_TRIGGERS[r.table_name] || []).includes(r.trigger_name));
    const missingTriggers = Object.entries(KNOWN_TRIGGERS).flatMap(([table, names]) =>
      names.filter((n) => !triggers.some((r) => r.table_name === table && r.trigger_name === n)).map((n) => `${table}.${n}`)
    );

    // --- Rule 1: MIGRATION_086 present exactly.
    const subStatusDef = await constraintDef('subscriptions', 'subscriptions_status_valid');
    const has086Statuses = ['active', 'past_due', 'cancelled', 'pending_payment', 'abandoned'].every((s) => subStatusDef.includes(`'${s}'`));
    const purchaseGuard = await prosrc('subscription_purchases_guard_mutation');
    const guardsPresent =
      (await prosrc('subscriptions_guard_pending')) !== null &&
      (await prosrc('invoices_guard_status_transition')) !== null &&
      purchaseGuard !== null;
    const purchaseStampsClock = !!purchaseGuard && purchaseGuard.includes('clock_timestamp()');
    const oneOpenIndex = await indexExists('subscription_purchases_one_open_per_company');
    const migration086Present = has086Statuses && guardsPresent && purchaseStampsClock && oneOpenIndex && missingTriggers.length === 0;
    console.log(
      `\n=== MIGRATION_086 prerequisite: 5-value status CHECK=${has086Statuses}, guards=${guardsPresent}, purchase stamps clock_timestamp()=${purchaseStampsClock}, one-open index=${oneOpenIndex}, missing triggers=[${missingTriggers.join(', ') || 'none'}] ===`
    );

    // --- Rule 2: no MIGRATION_087 artifact.
    const attemptsSrc = await prosrc('payment_attempts_guard_mutation');
    const sessionsSrc = await prosrc('payment_checkout_sessions_guard_mutation');
    const artifacts087 = {
      superseded_in_check: subStatusDef.includes("'superseded'"),
      replaces_column: await columnExists('subscription_purchases', 'replaces_subscription_id'),
      replaces_fk: (await constraintDef('subscription_purchases', 'subscription_purchases_replaces_fk')) !== '',
      replaces_not_self: (await constraintDef('subscription_purchases', 'subscription_purchases_replaces_not_self')) !== '',
      one_completed_index: await indexExists('subscription_purchases_one_completed_per_replaced'),
      attempts_guard_clock: !!attemptsSrc && attemptsSrc.includes('clock_timestamp()'),
      sessions_guard_clock: !!sessionsSrc && sessionsSrc.includes('clock_timestamp()'),
    };
    console.log('\n=== MIGRATION_087 artifacts already present ===');
    console.table([artifacts087]);
    const any087 = Object.values(artifacts087).some(Boolean);

    // --- Rule 3: attempt/session guard bodies equal MIGRATION_085's text.
    const migration085Text = fs.readFileSync(path.join(__dirname, 'MIGRATION_085_payment_simulator_foundation.sql'), 'utf8');
    const drifted = validateFunctionBodies(
      { payment_attempts_guard_mutation: attemptsSrc, payment_checkout_sessions_guard_mutation: sessionsSrc },
      migration085Text
    );

    // --- Rule 4: status set.
    const statusRows = (await client.query(`SELECT status, count(*)::int AS n FROM subscriptions GROUP BY status ORDER BY status NULLS FIRST`)).rows;
    console.log('\n=== subscriptions.status distribution ===');
    console.table(statusRows);
    const unexpectedStatuses = validateSubscriptionStatuses(statusRows.map((r) => r.status));

    // --- Rule 5: exact column set.
    const columns = (
      await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'subscriptions' ORDER BY ordinal_position`
      )
    ).rows.map((r) => r.column_name);
    const columnCheck = validateSubscriptionColumns(columns);
    console.log(`\n=== subscriptions columns (${columns.length}): ${columns.join(', ')} ===`);

    // --- Rule 7: at most one live row per company.
    const multiLive = (
      await client.query(
        `SELECT company_id, count(*)::int AS live FROM subscriptions
         WHERE status IN ('active','past_due') GROUP BY company_id HAVING count(*) > 1`
      )
    ).rows;

    // --- Read-only prints.
    console.log('\n=== live subscriptions by plan and interval ===');
    console.table(
      (
        await client.query(
          `SELECT plan, billing_interval, status, count(*)::int AS n FROM subscriptions
           WHERE status IN ('active','past_due') GROUP BY 1,2,3 ORDER BY 1,2,3`
        )
      ).rows
    );
    const planMismatch = (
      await client.query(
        `SELECT count(*)::int AS n FROM companies c JOIN subscriptions s
           ON s.company_id = c.id AND s.status IN ('active','past_due')
         WHERE c.plan IS DISTINCT FROM s.plan`
      )
    ).rows[0].n;
    console.log(`\n=== companies where companies.plan != live subscription plan: ${planMismatch} ===`);
    const unpaidOnActive = (
      await client.query(
        `SELECT s.company_id, s.plan, s.billing_interval, i.invoice_number, i.amount::text AS amount, i.currency
         FROM subscriptions s JOIN invoices i ON i.subscription_id = s.id
         WHERE s.status = 'active' AND i.status = 'issued' ORDER BY i.invoice_number`
      )
    ).rows;
    console.log(`\n=== active subscriptions with an issued (unpaid) invoice — blocked from upgrading (O7): ${unpaidOnActive.length} ===`);
    console.table(unpaidOnActive);
    console.log('\n=== open subscription purchases ===');
    console.table(
      (
        await client.query(
          `SELECT id, company_id, status, created_at, expires_at, (clock_timestamp() < expires_at) AS unexpired
           FROM subscription_purchases WHERE status = 'open' ORDER BY created_at`
        )
      ).rows
    );
    console.log('\n=== QA invoices (read-only) ===');
    console.table(
      (
        await client.query(
          `SELECT invoice_number, company_id, subscription_id, plan, billing_interval, status, amount::text AS amount, payment_date
           FROM invoices WHERE invoice_number = ANY($1::text[]) ORDER BY invoice_number`,
          [QA_INVOICE_NUMBERS]
        )
      ).rows
    );

    // --- Decision.
    if (any087) stop('one or more MIGRATION_087 artifacts already exist. Do not run it as-is; share this output for review.');
    if (!migration086Present) stop('MIGRATION_086 is not present exactly as reviewed. Apply/verify 086 first; do not run 087.');
    if (!any087 && drifted.length > 0) stop(`guard function body drift vs MIGRATION_085: ${drifted.join(', ')}. 087 would replace a body that differs from the reviewed text. Review before proceeding.`);
    if (unexpectedStatuses.length > 0) stop(`subscriptions has status value(s) outside {${ALLOWED_PRE_087_SUBSCRIPTION_STATUSES.join(', ')}}: ${unexpectedStatuses.join(', ')}.`);
    if (columnCheck.missing.length || columnCheck.extra.length) stop(`subscriptions columns differ from the 14 expected (missing=[${columnCheck.missing.join(', ')}], extra=[${columnCheck.extra.join(', ')}]). The 087 superseded guard compares a fixed column list.`);
    if (unknownTriggers.length > 0) stop(`unknown user trigger(s): ${unknownTriggers.map((r) => `${r.table_name}.${r.trigger_name}`).join(', ')}.`);
    if (multiLive.length > 0) stop(`${multiLive.length} company(ies) have more than one live subscription.`);

    if (stops.length > 0) {
      for (const s of stops) console.log(`\n>>> STOP: ${s}`);
      process.exitCode = 2;
    } else {
      console.log(
        '\n>>> Preflight passed: MIGRATION_086 is present exactly, no MIGRATION_087 artifact exists, the attempt/session guard bodies match MIGRATION_085, subscriptions.status and its 14 columns are as expected, no unknown trigger exists, and no company has more than one live subscription. MIGRATION_087 is structurally applicable; it has not been executed by this check.'
      );
    }
  } finally {
    await client.end();
  }
}

module.exports = {
  ALLOWED_PRE_087_SUBSCRIPTION_STATUSES,
  EXPECTED_SUBSCRIPTION_COLUMNS,
  validateSubscriptionStatuses,
  validateSubscriptionColumns,
  validateFunctionBodies,
  extractFunctionBody,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Preflight check failed:', err.message);
    process.exitCode = 1;
  });
}
