/**
 * Standalone concurrency proof for Stage B3 (admin.controller.ts's
 * createSubscriptionInvoice() and the refactored
 * company.controller.ts::deleteMe()).
 *
 * Follows the exact safety/observability conventions established by
 * docs/SMOKE_B1_admin_billing_audit_concurrency.js and
 * docs/SMOKE_B2_subscription_activation_concurrency.js (see those files' own
 * headers for the full rationale) — host validation with no default
 * substitution, SMOKE_CONFIRM_DISPOSABLE=yes required, one uniquely-named
 * throwaway database per run, every client closed before DROP DATABASE, a
 * cleanup failure fails the whole run, real observable lock-contention proof
 * via pg_stat_activity/pg_locks polling (never inferred from client-side
 * timing).
 *
 * Proves three things that mocked unit tests cannot:
 *
 *   Scenario 1 — invoice creation vs. invoice creation for the SAME
 *   subscription period. Exactly one must succeed; the other must fail with
 *   the specific 23505 on the named unique constraint
 *   (invoices_one_invoice_per_period), not a different/unrelated constraint,
 *   and no duplicate invoice row may exist afterward.
 *
 *   Scenario 2 — company deletion locks/commits FIRST (no invoices yet),
 *   then a queued invoice-creation attempt for the same company proceeds
 *   once the lock releases and correctly finds no company (404) — no orphan
 *   invoice is ever created for a company that no longer exists.
 *
 *   Scenario 3 — invoice creation locks/commits FIRST, then a queued
 *   deletion attempt for the same company proceeds once the lock releases
 *   and correctly observes the just-committed invoice, returning 409 and
 *   leaving both the company and the invoice intact — no silent invoice
 *   deletion is ever possible.
 *
 * Run with (bash):
 *   SMOKE_CONCURRENCY_ADMIN_URL="postgres://postgres:yourpassword@127.0.0.1:5432/postgres" \
 *   SMOKE_CONFIRM_DISPOSABLE=yes \
 *     node docs/SMOKE_B3_invoice_creation_concurrency.js
 *
 * Run with (Windows PowerShell):
 *   $env:SMOKE_CONCURRENCY_ADMIN_URL = "postgres://postgres:yourpassword@127.0.0.1:5432/postgres"
 *   $env:SMOKE_CONFIRM_DISPOSABLE = "yes"
 *   node docs/SMOKE_B3_invoice_creation_concurrency.js
 *
 * Point ADMIN_URL at a local/dev Postgres server you control, never at
 * production. The role needs CREATEDB.
 */

const { Client } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');
const crypto = require('crypto');

const RAW_ADMIN_URL = process.env.SMOKE_CONCURRENCY_ADMIN_URL;
const CONFIRM_DISPOSABLE = process.env.SMOKE_CONFIRM_DISPOSABLE;

const LOCK_POLL_INTERVAL_MS = 100;
const LOCK_POLL_TIMEOUT_MS = 5000;
const MONITOR_QUERY_TIMEOUT_MS = 1000;
const UNBLOCK_TIMEOUT_MS = 5000;
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
const DB_NAME = `smoke_b3_concurrency_${RUN_ID}`;
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

// Identical technique to SMOKE_B1/SMOKE_B2 — real, observable proof of lock
// contention via pg_stat_activity/pg_locks, bounded, never inferred from
// client-side timing.
async function waitForPidBlockedOnLock(monitorClient, pid, outcome) {
  const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (outcome.settled) {
      if (outcome.error) throw new Error(`Blocked party's query failed before contention could be observed: ${outcome.error.message}`);
      throw new Error(`Blocked party's query completed WITHOUT ever being observed blocked on a lock — no real contention occurred.`);
    }
    const remainingMs = Math.max(deadline - Date.now(), 1);
    const perQueryTimeout = Math.min(remainingMs, MONITOR_QUERY_TIMEOUT_MS);
    let row;
    try {
      const r = await withTimeout(
        monitorClient.query(`SELECT wait_event_type, wait_event, state FROM pg_stat_activity WHERE pid = $1`, [pid]),
        perQueryTimeout,
        'pg_stat_activity poll query'
      );
      row = r.rows[0];
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      await new Promise((r2) => setTimeout(r2, LOCK_POLL_INTERVAL_MS));
      continue;
    }
    if (row && row.wait_event_type === 'Lock') {
      const locksTimeout = Math.min(Math.max(deadline - Date.now(), 1), MONITOR_QUERY_TIMEOUT_MS);
      const locks = await withTimeout(
        monitorClient.query(`SELECT locktype, mode, granted FROM pg_locks WHERE pid = $1`, [pid]),
        locksTimeout,
        'pg_locks confirmation query'
      );
      return { waitEvent: row.wait_event, locks: locks.rows };
    }
    await new Promise((r2) => setTimeout(r2, LOCK_POLL_INTERVAL_MS));
  }
  throw new Error(`Never observed backend pid ${pid} blocked on a lock within ${LOCK_POLL_TIMEOUT_MS}ms — contention NOT confirmed.`);
}

async function closeAndWait(client, label) {
  if (!client) return;
  try {
    await withTimeout(client.end(), CLOSE_SETTLE_TIMEOUT_MS, `closing ${label}`);
  } catch (e) {
    console.error(`Warning: error closing ${label}: ${e.message}`);
  }
}

// --- Faithful copies of admin.controller.ts's / company.controller.ts's B3 SQL shapes ---

async function createInvoiceOnClient(client, companyId) {
  await client.query('BEGIN');
  const c = await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!c.rows[0]) {
    await client.query('ROLLBACK');
    const err = new Error('404 Company not found');
    err.isNotFound = true;
    throw err;
  }

  const subResult = await client.query(
    `SELECT * FROM subscriptions WHERE company_id = $1 AND status = 'active' FOR UPDATE`,
    [companyId]
  );
  const subscription = subResult.rows[0];
  if (!subscription) {
    await client.query('ROLLBACK');
    const err = new Error('409 no active commercial subscription');
    err.isNotEligible = true;
    throw err;
  }

  const issuedAt = new Date();
  let insertResult;
  try {
    insertResult = await client.query(
      `INSERT INTO invoices
         (company_id, subscription_id, plan, billing_interval, currency, amount,
          period_start, period_end, status, issue_date, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'issued',$9,$9)
       RETURNING *`,
      [
        companyId,
        subscription.id,
        subscription.plan,
        subscription.billing_interval,
        subscription.currency,
        subscription.period_amount,
        subscription.current_period_start,
        subscription.current_period_end,
        issuedAt,
      ]
    );
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'invoices_one_invoice_per_period') {
      await client.query('ROLLBACK');
      const err2 = new Error('409 conflict');
      err2.isConflict = true;
      err2.code = err.code;
      err2.constraint = err.constraint;
      throw err2;
    }
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }

  await client.query('COMMIT');
  return insertResult.rows[0];
}

async function deleteCompanyOnClient(client, companyId) {
  await client.query('BEGIN');
  const current = await client.query('SELECT name FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  const company = current.rows[0];
  if (!company) {
    await client.query('ROLLBACK');
    const err = new Error('404 Company not found');
    err.isNotFound = true;
    throw err;
  }

  const invoiceCheck = await client.query('SELECT 1 FROM invoices WHERE company_id = $1 LIMIT 1', [companyId]);
  if (invoiceCheck.rows.length > 0) {
    await client.query('ROLLBACK');
    const err = new Error('409 has invoices');
    err.isConflict = true;
    throw err;
  }

  await client.query('DELETE FROM companies WHERE id = $1', [companyId]);
  await client.query('COMMIT');
  return { deleted: true };
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
        status varchar(20) NOT NULL DEFAULT 'issued' CHECK (status IN ('issued')),
        issue_date timestamptz NOT NULL DEFAULT now(),
        due_date timestamptz NOT NULL CHECK (due_date >= issue_date),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT invoices_one_invoice_per_period UNIQUE (subscription_id, period_start, period_end),
        CONSTRAINT invoices_number_unique UNIQUE (invoice_number)
      );
    `);

    const checks = [];
    function check(desc, pass) { checks.push([desc, pass]); console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${desc}`); }

    async function insertActiveSubscription(companyId, overrides = {}) {
      const start = overrides.start || new Date('2026-09-15T00:00:00.000Z');
      const end = overrides.end || new Date('2026-10-15T00:00:00.000Z');
      const r = await setup.query(
        `INSERT INTO subscriptions (company_id, plan, status, currency, billing_interval, current_period_start, current_period_end, period_amount)
         VALUES ($1,'bronze','active','USD','monthly',$2,$3,32) RETURNING *`,
        [companyId, start, end]
      );
      return r.rows[0];
    }

    // ============================================================
    // Scenario 1 — invoice creation vs. invoice creation, same period
    // ============================================================
    console.log('\n--- Scenario 1: two concurrent invoice-creation attempts for the same subscription period ---');
    const co1 = (await setup.query(`INSERT INTO companies (name) VALUES ('Concurrency Co') RETURNING id`)).rows[0].id;
    await insertActiveSubscription(co1);

    const clientA1 = track(new Client(clientConfig(DB_NAME)));
    const clientB1 = track(new Client(clientConfig(DB_NAME)));
    await clientA1.connect();
    await clientB1.connect();

    const [r1, r2] = await Promise.allSettled([
      createInvoiceOnClient(clientA1, co1),
      createInvoiceOnClient(clientB1, co1),
    ]);
    const succeeded1 = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected1 = [r1, r2].filter((r) => r.status === 'rejected');

    check('exactly one of two concurrent invoice-creation attempts succeeds', succeeded1.length === 1);
    check(
      'the other fails specifically via the named unique constraint (23505 / invoices_one_invoice_per_period), not a different error',
      rejected1.length === 1 && rejected1[0].reason.isConflict && rejected1[0].reason.code === '23505' && rejected1[0].reason.constraint === 'invoices_one_invoice_per_period'
    );
    const countCo1 = await setup.query(`SELECT COUNT(*)::int AS n FROM invoices WHERE company_id=$1`, [co1]);
    check('exactly one invoice row exists for the contested subscription period afterward', countCo1.rows[0].n === 1);

    // ============================================================
    // Scenario 2 — deletion locks/commits first (no invoices yet), then
    // invoice creation proceeds and correctly finds no company
    // ============================================================
    console.log('\n--- Scenario 2: invoice creation blocked behind a held deletion lock; deletion commits first ---');
    const co2 = (await setup.query(`INSERT INTO companies (name) VALUES ('Delete First Co') RETURNING id`)).rows[0].id;
    await insertActiveSubscription(co2);

    const monitor = track(new Client(clientConfig(DB_NAME)));
    const deleteHolder2 = track(new Client(clientConfig(DB_NAME)));
    const invoiceClient2 = track(new Client(clientConfig(DB_NAME)));
    await monitor.connect();
    await deleteHolder2.connect();
    await invoiceClient2.connect();

    await deleteHolder2.query('BEGIN');
    await deleteHolder2.query('SELECT name FROM companies WHERE id = $1 FOR UPDATE', [co2]);

    const invoiceOutcome2 = { settled: false, error: null, result: null };
    const invoicePromise2 = createInvoiceOnClient(invoiceClient2, co2);
    invoicePromise2.then(
      (res) => { invoiceOutcome2.settled = true; invoiceOutcome2.result = res; },
      (err) => { invoiceOutcome2.settled = true; invoiceOutcome2.error = err; }
    );

    const blocked2 = await waitForPidBlockedOnLock(monitor, invoiceClient2.processID, invoiceOutcome2);
    check(
      'the invoice-creation attempt was genuinely blocked on a Postgres lock while the deletion lock was held (observed via pg_stat_activity/pg_locks, not inferred from timing)',
      blocked2.locks.length > 0
    );

    // Deletion sees no invoices yet, deletes, commits.
    const invoiceCheckBeforeDelete = await deleteHolder2.query('SELECT 1 FROM invoices WHERE company_id = $1 LIMIT 1', [co2]);
    check('deletion-first path sees no invoices before deleting', invoiceCheckBeforeDelete.rows.length === 0);
    await deleteHolder2.query('DELETE FROM companies WHERE id = $1', [co2]);
    await deleteHolder2.query('COMMIT');

    const invoiceResult2 = await withTimeout(
      invoicePromise2.catch((e) => e),
      UNBLOCK_TIMEOUT_MS,
      'invoice creation to settle after the deletion lock released'
    );
    check(
      'the previously-blocked invoice-creation attempt correctly finds no company (404) once the deletion has committed',
      invoiceResult2 instanceof Error && invoiceResult2.isNotFound === true
    );
    const orphanInvoices2 = await setup.query(`SELECT COUNT(*)::int AS n FROM invoices WHERE company_id=$1`, [co2]);
    check('no orphan invoice was created for the now-deleted company', orphanInvoices2.rows[0].n === 0);
    const companyGone2 = await setup.query('SELECT 1 FROM companies WHERE id=$1', [co2]);
    check('the company itself is gone', companyGone2.rows.length === 0);

    // ============================================================
    // Scenario 3 — invoice creation locks/commits first, then deletion
    // observes the invoice and rejects with 409
    // ============================================================
    console.log('\n--- Scenario 3: deletion blocked behind an uncommitted invoice creation; invoice commits first ---');
    const co3 = (await setup.query(`INSERT INTO companies (name) VALUES ('Invoice First Co') RETURNING id`)).rows[0].id;
    await insertActiveSubscription(co3);

    const invoiceHolder3 = track(new Client(clientConfig(DB_NAME)));
    const deleteClient3 = track(new Client(clientConfig(DB_NAME)));
    await invoiceHolder3.connect();
    await deleteClient3.connect();

    await invoiceHolder3.query('BEGIN');
    await invoiceHolder3.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [co3]);
    const sub3 = await invoiceHolder3.query(
      `SELECT * FROM subscriptions WHERE company_id = $1 AND status = 'active' FOR UPDATE`,
      [co3]
    );
    const issuedAt3 = new Date();
    const insertedInvoice3 = await invoiceHolder3.query(
      `INSERT INTO invoices
         (company_id, subscription_id, plan, billing_interval, currency, amount,
          period_start, period_end, status, issue_date, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'issued',$9,$9)
       RETURNING *`,
      [
        co3,
        sub3.rows[0].id,
        sub3.rows[0].plan,
        sub3.rows[0].billing_interval,
        sub3.rows[0].currency,
        sub3.rows[0].period_amount,
        sub3.rows[0].current_period_start,
        sub3.rows[0].current_period_end,
        issuedAt3,
      ]
    );

    const deleteOutcome3 = { settled: false, error: null, result: null };
    const deletePromise3 = deleteCompanyOnClient(deleteClient3, co3);
    deletePromise3.then(
      (res) => { deleteOutcome3.settled = true; deleteOutcome3.result = res; },
      (err) => { deleteOutcome3.settled = true; deleteOutcome3.error = err; }
    );
    const blocked3 = await waitForPidBlockedOnLock(monitor, deleteClient3.processID, deleteOutcome3);
    check('deletion was genuinely blocked on the company row while the invoice creation was uncommitted', blocked3.locks.length > 0);

    await invoiceHolder3.query('COMMIT');
    const deleteResult3 = await withTimeout(
      deletePromise3.catch((e) => e),
      UNBLOCK_TIMEOUT_MS,
      'deletion to settle after the invoice-creation lock released'
    );
    check(
      'the previously-blocked deletion correctly observes the just-committed invoice and rejects with a conflict',
      deleteResult3 instanceof Error && deleteResult3.isConflict === true
    );
    const companyStillThere3 = await setup.query('SELECT 1 FROM companies WHERE id=$1', [co3]);
    check('the company was NOT deleted', companyStillThere3.rows.length === 1);
    const invoiceStillThere3 = await setup.query('SELECT 1 FROM invoices WHERE id=$1', [insertedInvoice3.rows[0].id]);
    check('the invoice was NOT silently deleted', invoiceStillThere3.rows.length === 1);

    const allPass = checks.every(([, pass]) => pass);
    exitCode = allPass ? 0 : 1;
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
