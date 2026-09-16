/**
 * Standalone concurrency proof for Stage B5 (admin.controller.ts's
 * createPaymentAttempt() / markPaymentAttemptFailed(), and MIGRATION_084's
 * schema/trigger).
 *
 * Follows the exact safety/observability conventions established by
 * docs/SMOKE_B1_admin_billing_audit_concurrency.js /
 * docs/SMOKE_B2_subscription_activation_concurrency.js /
 * docs/SMOKE_B3_invoice_creation_concurrency.js (see those files' own headers
 * for the full rationale) — host validation with no default substitution,
 * SMOKE_CONFIRM_DISPOSABLE=yes required, one uniquely-named throwaway
 * database per run, every client closed before DROP DATABASE, a cleanup
 * failure fails the whole run. Unlike SMOKE_B3's Scenarios 2/3, none of B5's
 * scenarios need pg_stat_activity/pg_locks blocking-order proof — every race
 * here is two concurrent statements settled by a real unique
 * constraint/index/trigger, the same pattern SMOKE_B3's own Scenario 1
 * already used without lock polling.
 *
 * Builds minimal pre-MIGRATION_084 companies/subscriptions/invoices tables
 * matching the relevant post-MIGRATION_083 shape, then executes the real
 * MIGRATION_084 SQL file. This prevents the smoke proof from drifting away
 * from the artifact production will execute.
 *
 * 13 scenarios (see the approved v4 design doc §5 for the full numbered
 * list). Scenario 8 temporarily removes invoices_status_valid inside this
 * throwaway database so the forward-defensive not-'issued' controller guard
 * can be executed against real PostgreSQL; production keeps that CHECK.
 *
 *   1. Cross-tenant invoice/subscription rejection (invoices_subscription_company_fk).
 *   2. Cross-tenant payment-attempt rejection (payment_attempts_invoice_company_subscription_fk).
 *   3. Immutable-field UPDATE rejection for every listed column, including id.
 *   4. Idempotency-key concurrent-create race A: same invoice, same key.
 *   5. Idempotency-key concurrent-create race B: same invoice, different keys
 *      (payment_attempts_one_active_per_invoice).
 *   6. Two-different-invoices-same-key race (payment_attempts_idempotency_key_unique).
 *   7. Concurrent mark-failed: one 200-equivalent, one 409-equivalent, failed_at
 *      set exactly once, by the trigger.
 *   8. Invoice-not-'issued' rejection leaves no payment attempt.
 *   9. Rollback leaves no partial row (invoice not eligible).
 *  10. Direct DELETE FROM invoices with an attempt on it fails 23503 on
 *      payment_attempts_invoice_company_subscription_fk specifically (not
 *      invoices_company_id_fkey).
 *  11. Client-supplied decoy fields are ignored (INSERT ... SELECT never
 *      reads attacker-controlled amount/currency/etc.).
 *  12. Exact DECIMAL precision, string-compared, across a KWD and a USD case.
 *  13. Direct DELETE FROM payment_attempts is rejected by the trigger's
 *      DELETE branch, for both an 'initiated' and a 'failed' row.
 *
 * Run with (bash):
 *   SMOKE_CONCURRENCY_ADMIN_URL="postgres://postgres:yourpassword@127.0.0.1:5432/postgres" \
 *   SMOKE_CONFIRM_DISPOSABLE=yes \
 *     node docs/SMOKE_B5_payment_attempt_concurrency.js
 *
 * Run with (Windows PowerShell):
 *   $env:SMOKE_CONCURRENCY_ADMIN_URL = "postgres://postgres:yourpassword@127.0.0.1:5432/postgres"
 *   $env:SMOKE_CONFIRM_DISPOSABLE = "yes"
 *   node docs/SMOKE_B5_payment_attempt_concurrency.js
 *
 * Point ADMIN_URL at a local/dev Postgres server you control, never at
 * production. The role needs CREATEDB.
 */

const { Client } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RAW_ADMIN_URL = process.env.SMOKE_CONCURRENCY_ADMIN_URL;
const CONFIRM_DISPOSABLE = process.env.SMOKE_CONFIRM_DISPOSABLE;

const CLOSE_SETTLE_TIMEOUT_MS = 5000;

function fail(msg) {
  console.error(`REFUSING TO RUN: ${msg}`);
  process.exit(1);
}

if (!RAW_ADMIN_URL) {
  fail('SMOKE_CONCURRENCY_ADMIN_URL is not set. This script never reads DATABASE_URL or any .env file — set this one explicitly.');
}
if (/DATABASE_URL/i.test(RAW_ADMIN_URL)) {
  fail('SMOKE_CONCURRENCY_ADMIN_URL looks like an unexpanded shell reference (e.g. \'$DATABASE_URL\'), not a real connection string.');
}
if (CONFIRM_DISPOSABLE !== 'yes') {
  fail("Set SMOKE_CONFIRM_DISPOSABLE=yes to explicitly confirm the target Postgres instance is a disposable one you control.");
}

let parsedConfig;
try {
  parsedConfig = parseConnectionString(RAW_ADMIN_URL);
} catch (e) {
  fail('Could not parse SMOKE_CONCURRENCY_ADMIN_URL as a Postgres connection string.');
}

const rawHost = parsedConfig.host; // deliberately NOT `|| 'localhost'` — see SMOKE_B1's header for why
if (!rawHost) {
  const pgHostEnv = process.env.PGHOST;
  fail(
    `SMOKE_CONCURRENCY_ADMIN_URL has no explicit host. This script never substitutes a default, because ` +
    `\`pg\` itself would resolve the missing host from process.env.PGHOST` +
    `${pgHostEnv ? ` (currently "${pgHostEnv}")` : ' (or its own built-in default)'} ` +
    `— put an explicit host in the connection string itself.`
  );
}
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
if (!LOCAL_HOSTS.has(rawHost)) {
  fail(`Connection host is "${rawHost}", not one of (localhost, 127.0.0.1). Refusing to run against anything else.`);
}
const effectiveHost = rawHost;

function redacted(cfg) {
  return `postgres://${cfg.user || '(default)'}:***@${effectiveHost}:${cfg.port || 5432}/${cfg.database || '(default)'}`;
}
console.log(`Target (redacted): ${redacted(parsedConfig)}`);

const RUN_ID = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const DB_NAME = `smoke_b5_concurrency_${RUN_ID}`;
let dbCreated = false;

function clientConfig(dbName) {
  return { ...parsedConfig, host: effectiveHost, database: dbName };
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function oneShotClient(track, dbConfig) {
  const client = track(new Client(dbConfig));
  await client.connect();
  return client;
}

async function closeAndWait(client, label) {
  if (!client) return;
  try {
    await withTimeout(client.end(), CLOSE_SETTLE_TIMEOUT_MS, `closing ${label}`);
  } catch (e) {
    console.error(`Warning: error closing ${label}: ${e.message}`);
  }
}

// --- Faithful copies of admin.controller.ts's B5 SQL shapes ---
// (createPaymentAttempt's fixed-order 23505 recovery is NOT re-implemented
// here — that branch has no interesting Postgres-level behavior to prove
// beyond "the losing statement gets 23505", which every race scenario below
// already asserts directly; the recovery logic itself is covered by
// adminCreatePaymentAttempt.test.ts's mocked vitest tests.)

async function createPaymentAttemptOnClient(client, invoiceId, idempotencyKey) {
  await client.query('BEGIN');
  const inv = await client.query(`SELECT id, status FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
  const invoice = inv.rows[0];
  if (!invoice) {
    await client.query('ROLLBACK');
    const err = new Error('404 Invoice not found');
    err.isNotFound = true;
    throw err;
  }
  if (invoice.status !== 'issued') {
    await client.query('ROLLBACK');
    const err = new Error('409 Invoice is not eligible for a payment attempt');
    err.isNotEligible = true;
    throw err;
  }

  try {
    const insertResult = await client.query(
      `INSERT INTO payment_attempts (invoice_id, company_id, subscription_id, amount, currency,
         plan, billing_interval, period_start, period_end, idempotency_key, status)
       SELECT id, company_id, subscription_id, amount, currency, plan,
         billing_interval, period_start, period_end, $2, 'initiated'
       FROM invoices WHERE id = $1
       RETURNING *`,
      [invoiceId, idempotencyKey]
    );
    await client.query('COMMIT');
    return insertResult.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      await client.query('ROLLBACK');
      const err2 = new Error('409/200 conflict-or-replay (idempotency or one-active-per-invoice)');
      err2.isConflict = true;
      err2.code = err.code;
      err2.constraint = err.constraint;
      throw err2;
    }
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function markPaymentAttemptFailedOnClient(client, attemptId) {
  const result = await client.query(
    `UPDATE payment_attempts SET status = 'failed' WHERE id = $1 AND status = 'initiated' RETURNING *`,
    [attemptId]
  );
  if (result.rows[0]) return { ok: true, row: result.rows[0] };
  const existing = await client.query('SELECT id, status FROM payment_attempts WHERE id = $1', [attemptId]);
  if (!existing.rows[0]) return { ok: false, notFound: true };
  return { ok: false, conflict: true, currentStatus: existing.rows[0].status };
}

async function main() {
  const admin = new Client(clientConfig(parsedConfig.database));
  await admin.connect();
  try {
    console.log(`PostgreSQL server: ${(await admin.query('SELECT version()')).rows[0].version}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    dbCreated = true;
  } finally {
    await closeAndWait(admin, 'admin (create-database) connection');
  }

  let exitCode = 1;
  let cleanupFailed = false;
  const openClients = [];
  function track(c) { openClients.push(c); return c; }

  try {
    const setup = track(new Client(clientConfig(DB_NAME)));
    await setup.connect();
    await setup.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
    await setup.query(`
      CREATE TABLE companies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL DEFAULT 'Smoke Test Co'
      );
      CREATE TABLE subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        plan varchar(20) NOT NULL,
        status varchar(20) DEFAULT 'active',
        currency varchar(3) NOT NULL,
        billing_interval varchar(10) NOT NULL,
        current_period_start timestamptz NOT NULL,
        current_period_end timestamptz NOT NULL,
        period_amount decimal(10,3) NOT NULL,
        created_at timestamp DEFAULT now()
      );
      CREATE SEQUENCE macrocore_invoice_number_seq START 1;
      CREATE TABLE invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
        subscription_id uuid NOT NULL REFERENCES subscriptions(id),
        invoice_number varchar(20) NOT NULL
          DEFAULT ('MC-SUB-' || LPAD(nextval('macrocore_invoice_number_seq')::text, 6, '0')),
        plan varchar(20) NOT NULL,
        billing_interval varchar(10) NOT NULL,
        currency varchar(3) NOT NULL,
        amount decimal(10,3) NOT NULL CHECK (amount > 0),
        period_start timestamptz NOT NULL,
        period_end timestamptz NOT NULL CHECK (period_end > period_start),
        status varchar(20) NOT NULL DEFAULT 'issued'
          CONSTRAINT invoices_status_valid CHECK (status IN ('issued')),
        issue_date timestamptz NOT NULL DEFAULT now(),
        due_date timestamptz NOT NULL CHECK (due_date >= issue_date),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT invoices_one_invoice_per_period UNIQUE (subscription_id, period_start, period_end),
        CONSTRAINT invoices_number_unique UNIQUE (invoice_number)
      );
    `);

    // Apply the real migration file, rather than a copied DDL block that
    // could drift from the artifact production will execute.
    const migrationPath = path.resolve(__dirname, 'MIGRATION_084_payment_attempt_foundation.sql');
    await setup.query(fs.readFileSync(migrationPath, 'utf8'));

    const checks = [];
    function check(desc, pass) { checks.push([desc, pass]); console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${desc}`); }

    async function insertCompany(name) {
      return (await setup.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [name])).rows[0].id;
    }
    async function insertSubscription(companyId, overrides = {}) {
      const r = await setup.query(
        `INSERT INTO subscriptions (company_id, plan, status, currency, billing_interval, current_period_start, current_period_end, period_amount)
         VALUES ($1,'bronze','active',$2,'monthly',$3,$4,$5) RETURNING *`,
        [
          companyId,
          overrides.currency || 'USD',
          overrides.start || new Date('2026-09-15T00:00:00.000Z'),
          overrides.end || new Date('2026-10-15T00:00:00.000Z'),
          overrides.period_amount ?? 32,
        ]
      );
      return r.rows[0];
    }
    async function insertInvoice(companyId, subscriptionId, overrides = {}) {
      const sub = overrides.subscriptionRow;
      const issuedAt = new Date();
      const r = await setup.query(
        `INSERT INTO invoices (company_id, subscription_id, plan, billing_interval, currency, amount, period_start, period_end, status, issue_date, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'issued',$9,$9) RETURNING *`,
        [
          companyId, subscriptionId, sub.plan, sub.billing_interval, sub.currency, sub.period_amount,
          sub.current_period_start, sub.current_period_end, issuedAt,
        ]
      );
      return r.rows[0];
    }

    // ============================================================
    // Scenario 1 — cross-tenant invoice/subscription rejection
    // ============================================================
    console.log('\n--- Scenario 1: invoice with a company_id that mismatches its own subscription\'s company_id is rejected ---');
    const coA = await insertCompany('Tenant A');
    const coB = await insertCompany('Tenant B');
    const subA = await insertSubscription(coA);
    let s1err;
    try {
      await setup.query(
        `INSERT INTO invoices (company_id, subscription_id, plan, billing_interval, currency, amount, period_start, period_end, status, issue_date, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'issued',now(),now())`,
        [coB, subA.id, subA.plan, subA.billing_interval, subA.currency, subA.period_amount, subA.current_period_start, subA.current_period_end]
      );
    } catch (e) { s1err = e; }
    check(
      'rejected with 23503 on invoices_subscription_company_fk when company_id belongs to a different tenant than subscription_id',
      s1err && s1err.code === '23503' && s1err.constraint === 'invoices_subscription_company_fk'
    );

    // ============================================================
    // Scenario 2 — cross-tenant payment-attempt rejection
    // ============================================================
    console.log('\n--- Scenario 2: payment_attempts row with a company_id/subscription_id that mismatches the real invoice is rejected ---');
    const invA = await insertInvoice(coA, subA.id, { subscriptionRow: subA });
    const coC = await insertCompany('Tenant C');
    const subC = await insertSubscription(coC);
    let s2err;
    try {
      await setup.query(
        `INSERT INTO payment_attempts (invoice_id, company_id, subscription_id, amount, currency, plan, billing_interval, period_start, period_end, idempotency_key, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'initiated')`,
        [invA.id, coC, subC.id, invA.amount, invA.currency, invA.plan, invA.billing_interval, invA.period_start, invA.period_end, 'decoy-key-s2']
      );
    } catch (e) { s2err = e; }
    check(
      'rejected with 23503 on payment_attempts_invoice_company_subscription_fk when invoice_id is real but company_id/subscription_id do not match it',
      s2err && s2err.code === '23503' && s2err.constraint === 'payment_attempts_invoice_company_subscription_fk'
    );

    // ============================================================
    // Scenario 3 — immutable-field UPDATE rejection, every listed column
    // ============================================================
    console.log('\n--- Scenario 3: every immutable column (including id) rejects UPDATE ---');
    const attempt3 = await createPaymentAttemptOnClient(await oneShotClient(track, clientConfig(DB_NAME)), invA.id, 'scenario-3-key');
    const immutableColumnUpdates = {
      id: `gen_random_uuid()`,
      invoice_id: `gen_random_uuid()`,
      company_id: `gen_random_uuid()`,
      subscription_id: `gen_random_uuid()`,
      amount: `amount + 1`,
      currency: `'KWD'`,
      plan: `'gold'`,
      billing_interval: `'annual'`,
      period_start: `period_start + interval '1 day'`,
      period_end: `period_end + interval '1 day'`,
      idempotency_key: `'tampered-key'`,
      created_at: `created_at + interval '1 day'`,
    };
    let allImmutableRejected = true;
    for (const [col, expr] of Object.entries(immutableColumnUpdates)) {
      try {
        await setup.query(`UPDATE payment_attempts SET ${col} = ${expr} WHERE id = $1`, [attempt3.id]);
        allImmutableRejected = false;
        console.log(`    [FAIL] column "${col}" was NOT rejected`);
      } catch (e) {
        if (!/immutable/i.test(e.message)) {
          allImmutableRejected = false;
          console.log(`    [FAIL] column "${col}" rejected for the wrong reason: ${e.message}`);
        }
      }
    }
    check('every immutable column (id, invoice_id, company_id, subscription_id, amount, currency, plan, billing_interval, period_start, period_end, idempotency_key, created_at) rejects UPDATE via the trigger', allImmutableRejected);
    // Design doc §2 Correction 2 / the approved matrix: "No-op updates,
    // repeated transitions, snapshot changes, identity changes, and
    // idempotency-key changes are all still rejected" — the trigger has no
    // special case for "nothing really changed"; the ONLY row-level UPDATE it
    // ever allows is the one real 'initiated' -> 'failed' transition. A
    // same-value status UPDATE is therefore expected to be rejected too.
    let noOpUpdateErr;
    try {
      await setup.query(`UPDATE payment_attempts SET status = status WHERE id = $1 RETURNING *`, [attempt3.id]);
    } catch (e) { noOpUpdateErr = e; }
    check(
      'a true no-op UPDATE (status set to its own current value) is REJECTED — the trigger permits only the single initiated -> failed transition, never a same-value "update"',
      !!noOpUpdateErr && /not permitted/i.test(noOpUpdateErr.message)
    );
    let invalidInitialStateErr;
    try {
      await setup.query(
        `INSERT INTO payment_attempts
           (invoice_id, company_id, subscription_id, amount, currency, plan,
            billing_interval, period_start, period_end, idempotency_key, status, failed_at)
         SELECT id, company_id, subscription_id, amount, currency, plan,
                billing_interval, period_start, period_end, 'invalid-initial-state', 'failed', now()
         FROM invoices WHERE id = $1`,
        [invA.id]
      );
    } catch (e) { invalidInitialStateErr = e; }
    check(
      'a direct INSERT cannot bypass the lifecycle by creating a row already in terminal failed state',
      !!invalidInitialStateErr && /must start as initiated/i.test(invalidInitialStateErr.message)
    );
    const coNormalized = await insertCompany('Tenant normalized-key');
    const subNormalized = await insertSubscription(coNormalized);
    const invNormalized = await insertInvoice(coNormalized, subNormalized.id, { subscriptionRow: subNormalized });
    let unnormalizedKeyErr;
    try {
      await setup.query(
        `INSERT INTO payment_attempts
           (invoice_id, company_id, subscription_id, amount, currency, plan,
            billing_interval, period_start, period_end, idempotency_key, status)
         SELECT id, company_id, subscription_id, amount, currency, plan,
                billing_interval, period_start, period_end, ' leading-space', 'initiated'
         FROM invoices WHERE id = $1`,
        [invNormalized.id]
      );
    } catch (e) { unnormalizedKeyErr = e; }
    check(
      'the database rejects an idempotency key that is not already normalized',
      !!unnormalizedKeyErr && unnormalizedKeyErr.constraint === 'payment_attempts_idempotency_key_normalized'
    );

    // ============================================================
    // Scenario 4 — idempotency-key concurrent-create race A: same invoice, same key
    // ============================================================
    console.log('\n--- Scenario 4: two concurrent creates, same invoice, same idempotency key ---');
    const coD = await insertCompany('Tenant D');
    const subD = await insertSubscription(coD);
    const invD = await insertInvoice(coD, subD.id, { subscriptionRow: subD });
    const c4a = track(new Client(clientConfig(DB_NAME)));
    const c4b = track(new Client(clientConfig(DB_NAME)));
    await c4a.connect(); await c4b.connect();
    const [r4a, r4b] = await Promise.allSettled([
      createPaymentAttemptOnClient(c4a, invD.id, 'same-key-same-invoice'),
      createPaymentAttemptOnClient(c4b, invD.id, 'same-key-same-invoice'),
    ]);
    const succeeded4 = [r4a, r4b].filter((r) => r.status === 'fulfilled');
    const rejected4 = [r4a, r4b].filter((r) => r.status === 'rejected');
    check('exactly one of two concurrent same-invoice/same-key creates succeeds', succeeded4.length === 1);
    check('the other fails with 23505 (unique violation), any constraint', rejected4.length === 1 && rejected4[0].reason.code === '23505');
    const count4 = await setup.query(`SELECT COUNT(*)::int AS n FROM payment_attempts WHERE invoice_id=$1`, [invD.id]);
    check('exactly one payment_attempts row exists for this invoice afterward', count4.rows[0].n === 1);

    // ============================================================
    // Scenario 5 — idempotency-key concurrent-create race B: same invoice, different keys
    // ============================================================
    console.log('\n--- Scenario 5: two concurrent creates, same invoice, DIFFERENT idempotency keys (one-active-per-invoice race) ---');
    const coE = await insertCompany('Tenant E');
    const subE = await insertSubscription(coE);
    const invE = await insertInvoice(coE, subE.id, { subscriptionRow: subE });
    const c5a = track(new Client(clientConfig(DB_NAME)));
    const c5b = track(new Client(clientConfig(DB_NAME)));
    await c5a.connect(); await c5b.connect();
    const [r5a, r5b] = await Promise.allSettled([
      createPaymentAttemptOnClient(c5a, invE.id, 'diff-key-a'),
      createPaymentAttemptOnClient(c5b, invE.id, 'diff-key-b'),
    ]);
    const succeeded5 = [r5a, r5b].filter((r) => r.status === 'fulfilled');
    const rejected5 = [r5a, r5b].filter((r) => r.status === 'rejected');
    check('exactly one of two concurrent same-invoice/different-key creates succeeds', succeeded5.length === 1);
    check(
      'the other fails specifically via payment_attempts_one_active_per_invoice',
      rejected5.length === 1 && rejected5[0].reason.code === '23505' && rejected5[0].reason.constraint === 'payment_attempts_one_active_per_invoice'
    );
    const count5 = await setup.query(`SELECT COUNT(*)::int AS n FROM payment_attempts WHERE invoice_id=$1 AND status='initiated'`, [invE.id]);
    check('exactly one initiated attempt exists for this invoice afterward', count5.rows[0].n === 1);

    // ============================================================
    // Scenario 6 — two-different-invoices-same-key race
    // ============================================================
    console.log('\n--- Scenario 6: two concurrent creates, TWO DIFFERENT invoices, same idempotency key ---');
    const coF = await insertCompany('Tenant F');
    const subF = await insertSubscription(coF, { start: new Date('2026-09-15T00:00:00.000Z'), end: new Date('2026-10-15T00:00:00.000Z') });
    const invF1 = await insertInvoice(coF, subF.id, { subscriptionRow: subF });
    // A second, distinct invoice needs a different period on the same subscription (invoices_one_invoice_per_period);
    // simplest is a second subscription entirely.
    const coG = await insertCompany('Tenant G');
    const subG = await insertSubscription(coG);
    const invG1 = await insertInvoice(coG, subG.id, { subscriptionRow: subG });
    const c6a = track(new Client(clientConfig(DB_NAME)));
    const c6b = track(new Client(clientConfig(DB_NAME)));
    await c6a.connect(); await c6b.connect();
    const [r6a, r6b] = await Promise.allSettled([
      createPaymentAttemptOnClient(c6a, invF1.id, 'shared-cross-invoice-key'),
      createPaymentAttemptOnClient(c6b, invG1.id, 'shared-cross-invoice-key'),
    ]);
    const succeeded6 = [r6a, r6b].filter((r) => r.status === 'fulfilled');
    const rejected6 = [r6a, r6b].filter((r) => r.status === 'rejected');
    check('exactly one of two concurrent different-invoice/same-key creates succeeds', succeeded6.length === 1);
    check(
      'the other fails specifically via payment_attempts_idempotency_key_unique (not the per-invoice index, since the invoices differ)',
      rejected6.length === 1 && rejected6[0].reason.code === '23505' && rejected6[0].reason.constraint === 'payment_attempts_idempotency_key_unique'
    );

    // ============================================================
    // Scenario 7 — concurrent mark-failed
    // ============================================================
    console.log('\n--- Scenario 7: two concurrent mark-failed calls on the same attempt ---');
    const coH = await insertCompany('Tenant H');
    const subH = await insertSubscription(coH);
    const invH = await insertInvoice(coH, subH.id, { subscriptionRow: subH });
    const attempt7real = await createPaymentAttemptOnClient(await oneShotClient(track, clientConfig(DB_NAME)), invH.id, 'scenario-7-key');
    const c7a = track(new Client(clientConfig(DB_NAME)));
    const c7b = track(new Client(clientConfig(DB_NAME)));
    await c7a.connect(); await c7b.connect();
    const [r7a, r7b] = await Promise.allSettled([
      markPaymentAttemptFailedOnClient(c7a, attempt7real.id),
      markPaymentAttemptFailedOnClient(c7b, attempt7real.id),
    ]);
    const results7 = [r7a, r7b].map((r) => (r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason }));
    const ok7 = results7.filter((r) => r.ok === true);
    const conflict7 = results7.filter((r) => r.ok === false && r.conflict === true);
    check('exactly one of two concurrent mark-failed calls succeeds (200-equivalent)', ok7.length === 1);
    check('the other observes the conflict (409-equivalent, already failed)', conflict7.length === 1);
    const finalAttempt7 = await setup.query('SELECT status, failed_at FROM payment_attempts WHERE id = $1', [attempt7real.id]);
    const successfulFailedAt7 = ok7[0]?.row?.failed_at;
    check(
      'final status is failed and the losing repeat did not replace the trigger-owned failed_at',
      finalAttempt7.rows[0].status === 'failed' &&
        successfulFailedAt7 instanceof Date &&
        finalAttempt7.rows[0].failed_at.toISOString() === successfulFailedAt7.toISOString()
    );
    let terminalReopenErr;
    try {
      await setup.query(`UPDATE payment_attempts SET status = 'initiated' WHERE id = $1`, [attempt7real.id]);
    } catch (e) { terminalReopenErr = e; }
    check(
      'a terminal failed attempt cannot be reopened to initiated by direct SQL',
      !!terminalReopenErr && /not permitted/i.test(terminalReopenErr.message)
    );

    // ============================================================
    // Scenario 8 — invoice not eligible
    // ============================================================
    console.log('\n--- Scenario 8: a non-issued invoice is rejected and leaves no attempt ---');
    await setup.query('ALTER TABLE invoices DROP CONSTRAINT invoices_status_valid');
    const coL = await insertCompany('Tenant L');
    const subL = await insertSubscription(coL);
    const issuedAtL = new Date();
    const invL = (await setup.query(
      `INSERT INTO invoices
         (company_id, subscription_id, plan, billing_interval, currency, amount,
          period_start, period_end, status, issue_date, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'void',$9,$9)
       RETURNING id`,
      [coL, subL.id, subL.plan, subL.billing_interval, subL.currency, subL.period_amount,
        subL.current_period_start, subL.current_period_end, issuedAtL]
    )).rows[0];
    let s8err;
    try {
      await createPaymentAttemptOnClient(await oneShotClient(track, clientConfig(DB_NAME)), invL.id, 'scenario-8-key');
    } catch (e) { s8err = e; }
    check('create against a non-issued invoice fails as not-eligible', !!s8err && s8err.isNotEligible === true);
    const count8 = await setup.query(`SELECT COUNT(*)::int AS n FROM payment_attempts WHERE idempotency_key = $1`, ['scenario-8-key']);
    check('the rejected non-issued invoice leaves no payment_attempts row', count8.rows[0].n === 0);

    // ============================================================
    // Scenario 9 — rollback leaves no partial row
    // ============================================================
    console.log('\n--- Scenario 9: a failed create (invoice not found) leaves no partial payment_attempts row ---');
    const fakeInvoiceId = '00000000-0000-0000-0000-000000000000';
    let s9err;
    try {
      await createPaymentAttemptOnClient(await oneShotClient(track, clientConfig(DB_NAME)), fakeInvoiceId, 'scenario-9-key');
    } catch (e) { s9err = e; }
    check('create against a nonexistent invoice fails as not-found', !!s9err && s9err.isNotFound === true);
    const count9 = await setup.query(`SELECT COUNT(*)::int AS n FROM payment_attempts WHERE idempotency_key = $1`, ['scenario-9-key']);
    check('no partial payment_attempts row was left behind', count9.rows[0].n === 0);

    // ============================================================
    // Scenario 10 — DELETE FROM invoices blocked, corrected constraint
    // ============================================================
    console.log('\n--- Scenario 10: direct DELETE FROM invoices with an attempt on it fails on the CORRECT constraint ---');
    let s10err;
    try {
      await setup.query('DELETE FROM invoices WHERE id = $1', [invA.id]); // invA has attempt3 (scenario 3) on it
    } catch (e) { s10err = e; }
    check(
      'rejected with 23503 specifically on payment_attempts_invoice_company_subscription_fk, NOT invoices_company_id_fkey',
      s10err && s10err.code === '23503' && s10err.constraint === 'payment_attempts_invoice_company_subscription_fk'
    );

    // ============================================================
    // Scenario 11 — client-supplied decoy fields ignored
    // ============================================================
    console.log('\n--- Scenario 11: INSERT ... SELECT never reads client-controlled values, only the real invoice row ---');
    const coI = await insertCompany('Tenant I');
    const subI = await insertSubscription(coI, { currency: 'KWD', period_amount: 41.5 });
    const invI = await insertInvoice(coI, subI.id, { subscriptionRow: subI });
    // Faithful shape: even if a hypothetical caller-controlled amount/currency/plan
    // existed in the request body, the actual controller SQL (INSERT ... SELECT
    // ... FROM invoices) has no parameter slot for them at all — proven structurally
    // by using the exact same createPaymentAttemptOnClient() helper used everywhere
    // else in this file (no decoy fields are ever threaded into it) and asserting
    // the resulting row matches the invoice, not any external value.
    const attempt11 = await createPaymentAttemptOnClient(await oneShotClient(track, clientConfig(DB_NAME)), invI.id, 'scenario-11-key');
    check(
      'created attempt\'s snapshot columns come from the real invoice row, matching it exactly',
      attempt11.amount === invI.amount && attempt11.currency === invI.currency && attempt11.plan === invI.plan &&
      attempt11.billing_interval === invI.billing_interval
    );

    // ============================================================
    // Scenario 12 — exact DECIMAL precision, KWD and USD
    // ============================================================
    console.log('\n--- Scenario 12: exact DECIMAL(10,3) precision preserved, string-compared, KWD and USD ---');
    const coJ = await insertCompany('Tenant J (KWD)');
    const subJ = await insertSubscription(coJ, { currency: 'KWD', period_amount: '41.750' });
    const invJ = await insertInvoice(coJ, subJ.id, { subscriptionRow: subJ });
    const attempt12kwd = await createPaymentAttemptOnClient(await oneShotClient(track, clientConfig(DB_NAME)), invJ.id, 'scenario-12-kwd-key');
    const rawKwd = await setup.query(`SELECT amount::text AS amount_text FROM payment_attempts WHERE id = $1`, [attempt12kwd.id]);
    check('KWD case: exact string "41.750" preserved with no float rounding', rawKwd.rows[0].amount_text === '41.750');

    const coK = await insertCompany('Tenant K (USD)');
    const subK = await insertSubscription(coK, { currency: 'USD', period_amount: '99.990' });
    const invK = await insertInvoice(coK, subK.id, { subscriptionRow: subK });
    const attempt12usd = await createPaymentAttemptOnClient(await oneShotClient(track, clientConfig(DB_NAME)), invK.id, 'scenario-12-usd-key');
    const rawUsd = await setup.query(`SELECT amount::text AS amount_text FROM payment_attempts WHERE id = $1`, [attempt12usd.id]);
    check('USD case: exact string "99.990" preserved with no float rounding', rawUsd.rows[0].amount_text === '99.990');

    // ============================================================
    // Scenario 13 — direct DELETE FROM payment_attempts rejected (append-only)
    // ============================================================
    console.log('\n--- Scenario 13: direct DELETE FROM payment_attempts is always rejected ---');
    let s13aErr;
    try { await setup.query('DELETE FROM payment_attempts WHERE id = $1', [attempt11.id]); } catch (e) { s13aErr = e; }
    check('DELETE on an \'initiated\' row is rejected by the trigger', s13aErr && /append-only/i.test(s13aErr.message));

    let s13bErr;
    try { await setup.query('DELETE FROM payment_attempts WHERE id = $1', [attempt7real.id]); } catch (e) { s13bErr = e; }
    check('DELETE on a \'failed\' row is also rejected by the trigger', s13bErr && /append-only/i.test(s13bErr.message));

    const allPass = checks.every(([, pass]) => pass);
    exitCode = allPass ? 0 : 1;
    console.log(`\n${checks.filter(([, p]) => p).length}/${checks.length} checks passed.`);
  } finally {
    for (const c of openClients) await closeAndWait(c, 'test connection');
    if (dbCreated) {
      const cleanup = new Client(clientConfig(parsedConfig.database));
      try {
        await cleanup.connect();
        await cleanup.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [DB_NAME]
        );
        await cleanup.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
        console.log(`\nCleanup: dropped ${DB_NAME}`);
      } catch (e) {
        cleanupFailed = true;
        console.error(`CLEANUP FAILED: could not confirm ${DB_NAME} was dropped (${e.message}). It may still exist: DROP DATABASE ${DB_NAME};`);
      } finally {
        await closeAndWait(cleanup, 'admin (cleanup) connection');
      }
    }
  }

  if (cleanupFailed) exitCode = exitCode === 0 ? 1 : exitCode;
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(2);
});
