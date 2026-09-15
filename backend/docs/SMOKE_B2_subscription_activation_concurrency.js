/**
 * Standalone concurrency proof for Stage B2 (admin.controller.ts's
 * activateSubscription() and the updateCompany() legacy-PATCH guard).
 *
 * Follows the exact safety/observability conventions established by
 * docs/SMOKE_B1_admin_billing_audit_concurrency.js (see that file's own
 * header for the full rationale) — host validation with no default
 * substitution, SMOKE_CONFIRM_DISPOSABLE=yes required, one uniquely-named
 * throwaway database per run, every client closed before DROP DATABASE, a
 * cleanup failure fails the whole run, real observable lock-contention proof
 * via pg_stat_activity/pg_locks polling (never inferred from client-side
 * timing).
 *
 * Proves two things that mocked unit tests cannot:
 *
 *   Scenario 1 — activation vs. activation: two concurrent
 *   POST .../subscription/activate calls for the SAME company. Exactly one
 *   must succeed; the other must fail with the specific 23505 on the named
 *   partial unique index (subscriptions_one_live_per_company), not a
 *   different/unrelated constraint, and no duplicate live row may exist
 *   afterward.
 *
 *   Scenarios 2/3 — activation vs. legacy PATCH in both lock orders. The
 *   blocked side is observed through pg_stat_activity/pg_locks. Most
 *   importantly, PATCH takes the company lock and only then reads managed
 *   state in a separate READ COMMITTED statement, so a PATCH that waited for
 *   activation sees the newly committed subscription and rejects plan drift.
 *
 * Run with (bash):
 *   SMOKE_CONCURRENCY_ADMIN_URL="postgres://postgres:yourpassword@127.0.0.1:5432/postgres" \
 *   SMOKE_CONFIRM_DISPOSABLE=yes \
 *     node docs/SMOKE_B2_subscription_activation_concurrency.js
 *
 * Run with (Windows PowerShell):
 *   $env:SMOKE_CONCURRENCY_ADMIN_URL = "postgres://postgres:yourpassword@127.0.0.1:5432/postgres"
 *   $env:SMOKE_CONFIRM_DISPOSABLE = "yes"
 *   node docs/SMOKE_B2_subscription_activation_concurrency.js
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
const DB_NAME = `smoke_b2_concurrency_${RUN_ID}`;
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

// Identical technique to SMOKE_B1 — real, observable proof of lock
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

// --- Faithful copies of admin.controller.ts's B2 SQL shapes ---

async function activateOnClient(client, companyId, { plan, interval, currency, amount }) {
  const monthlyPrice = interval === 'annual' ? Math.round((amount / 12) * 1000) / 1000 : amount;
  const start = new Date();
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + (interval === 'annual' ? 12 : 1));

  await client.query('BEGIN');
  const c = await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!c.rows[0]) { await client.query('ROLLBACK'); throw new Error('404 Company not found'); }

  let insertResult;
  try {
    insertResult = await client.query(
      `INSERT INTO subscriptions
         (company_id, plan, status, currency, period_amount, monthly_price,
          billing_interval, current_period_start, current_period_end, auto_renew, next_billing_date)
       VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8,false,($8 AT TIME ZONE 'UTC'))
       RETURNING *`,
      [companyId, plan, currency, amount, monthlyPrice, interval, start, end]
    );
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'subscriptions_one_live_per_company') {
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

  await client.query(`UPDATE companies SET plan=$1, subscription_status='active' WHERE id=$2`, [plan, companyId]);
  await client.query('COMMIT');
  return insertResult.rows[0];
}

async function changePlanOnClient(client, companyId, plan) {
  await client.query('BEGIN');
  const company = await client.query('SELECT id, plan FROM companies WHERE id=$1 FOR UPDATE', [companyId]);
  if (!company.rows[0]) throw new Error('404 Company not found');
  const managed = await client.query(
    `SELECT EXISTS (SELECT 1 FROM subscriptions WHERE company_id=$1 AND status IN ('active','past_due')) AS is_managed`,
    [companyId]
  );
  if (managed.rows[0].is_managed && plan !== company.rows[0].plan) {
    await client.query('ROLLBACK');
    return { blocked: true };
  }
  await client.query('UPDATE companies SET plan=$1 WHERE id=$2', [plan, companyId]);
  await client.query('COMMIT');
  return { blocked: false };
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
        name text NOT NULL DEFAULT 'Smoke Test Co',
        plan text NOT NULL DEFAULT 'trial',
        subscription_status text NOT NULL DEFAULT 'trial'
      );
      CREATE TABLE subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        plan varchar(20) NOT NULL,
        status varchar(20) DEFAULT 'active',
        monthly_price decimal(10,3),
        auto_renew boolean DEFAULT true,
        next_billing_date timestamp,
        created_at timestamp DEFAULT now(),
        updated_at timestamp DEFAULT now(),
        currency varchar(3) NOT NULL,
        billing_interval varchar(10) NOT NULL,
        current_period_start timestamptz NOT NULL,
        current_period_end timestamptz NOT NULL,
        period_amount decimal(10,3) NOT NULL,
        CONSTRAINT subscriptions_currency_supported CHECK (currency IN ('USD','KWD')),
        CONSTRAINT subscriptions_billing_interval_valid CHECK (billing_interval IN ('monthly','annual')),
        CONSTRAINT subscriptions_period_amount_positive CHECK (period_amount > 0),
        CONSTRAINT subscriptions_period_end_after_start CHECK (current_period_end > current_period_start)
      );
      CREATE UNIQUE INDEX subscriptions_one_live_per_company
        ON subscriptions (company_id) WHERE status IN ('active','past_due');
    `);

    const checks = [];
    function check(desc, pass) { checks.push([desc, pass]); console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${desc}`); }

    // ============================================================
    // Scenario 1 — activation vs. activation
    // ============================================================
    console.log('\n--- Scenario 1: two concurrent activations for the same company ---');
    const co1 = (await setup.query(`INSERT INTO companies (name) VALUES ('Concurrency Co') RETURNING id`)).rows[0].id;

    const clientA1 = track(new Client(clientConfig(DB_NAME)));
    const clientB1 = track(new Client(clientConfig(DB_NAME)));
    await clientA1.connect();
    await clientB1.connect();

    const [r1, r2] = await Promise.allSettled([
      activateOnClient(clientA1, co1, { plan: 'gold', interval: 'monthly', currency: 'USD', amount: 67 }),
      activateOnClient(clientB1, co1, { plan: 'silver', interval: 'monthly', currency: 'USD', amount: 39 }),
    ]);
    const succeeded1 = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected1 = [r1, r2].filter((r) => r.status === 'rejected');

    check('exactly one of two concurrent activations succeeds', succeeded1.length === 1);
    check(
      'the other fails specifically via the named partial unique index (23505 / subscriptions_one_live_per_company), not a different error',
      rejected1.length === 1 && rejected1[0].reason.isConflict && rejected1[0].reason.code === '23505' && rejected1[0].reason.constraint === 'subscriptions_one_live_per_company'
    );
    const countCo1 = await setup.query(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE company_id=$1`, [co1]);
    check('exactly one subscription row exists for the contested company afterward', countCo1.rows[0].n === 1);

    // ============================================================
    // Scenario 2 — activation vs. legacy PATCH, real observable contention
    // ============================================================
    console.log('\n--- Scenario 2: activation blocked behind a held legacy-PATCH-style row lock ---');
    const co2 = (await setup.query(`INSERT INTO companies (name) VALUES ('Race Co') RETURNING id`)).rows[0].id;

    const monitor = track(new Client(clientConfig(DB_NAME)));
    const heldLockClient = track(new Client(clientConfig(DB_NAME)));
    const activateClient = track(new Client(clientConfig(DB_NAME)));
    await monitor.connect();
    await heldLockClient.connect();
    await activateClient.connect();

    // Start the fixed PATCH transaction and hold its first lock so the
    // competing activation is observably queued behind it.
    await heldLockClient.query('BEGIN');
    await heldLockClient.query('SELECT id, plan FROM companies WHERE id = $1 FOR UPDATE', [co2]);

    const activateOutcome = { settled: false, error: null, result: null };
    const activatePromise = activateOnClient(activateClient, co2, { plan: 'bronze', interval: 'monthly', currency: 'USD', amount: 32 });
    activatePromise.then(
      (res) => { activateOutcome.settled = true; activateOutcome.result = res; },
      (err) => { activateOutcome.settled = true; activateOutcome.error = err; }
    );

    const blockedEvidence = await waitForPidBlockedOnLock(monitor, activateClient.processID, activateOutcome);
    check(
      'the activation attempt was genuinely blocked on a Postgres lock while the legacy-PATCH-style lock was held (observed via pg_stat_activity/pg_locks, not inferred from timing)',
      blockedEvidence.locks.length > 0
    );

    // Complete the PATCH first. It sees no live subscription, changes plan,
    // and commits. Activation then proceeds and atomically becomes the final
    // source for both rows.
    const managedBeforeActivation = await heldLockClient.query(
      `SELECT EXISTS (SELECT 1 FROM subscriptions WHERE company_id=$1 AND status IN ('active','past_due')) AS is_managed`,
      [co2]
    );
    check('PATCH-first path sees the company as unmanaged before activation commits', managedBeforeActivation.rows[0].is_managed === false);
    await heldLockClient.query("UPDATE companies SET plan='silver' WHERE id=$1", [co2]);
    await heldLockClient.query('COMMIT');
    const activationResult = await withTimeout(activatePromise, UNBLOCK_TIMEOUT_MS, 'activation to complete after the held lock released');
    check('the previously-blocked activation completed successfully once the lock was released', !!activationResult && activationResult.plan === 'bronze');

    const finalCompany2 = await setup.query('SELECT plan FROM companies WHERE id=$1', [co2]);
    const finalSub2 = await setup.query(`SELECT plan FROM subscriptions WHERE company_id=$1 AND status='active'`, [co2]);
    check(
      'companies.plan and the live subscriptions row plan agree after the race resolves',
      finalSub2.rows.length === 1 && finalCompany2.rows[0].plan === finalSub2.rows[0].plan
    );

    // ============================================================
    // Scenario 3 — activation first, PATCH must refresh after waiting
    // ============================================================
    console.log('\n--- Scenario 3: legacy PATCH blocked behind an uncommitted activation ---');
    const co3 = (await setup.query(`INSERT INTO companies (name) VALUES ('Activation First Co') RETURNING id`)).rows[0].id;
    const activationHolder = track(new Client(clientConfig(DB_NAME)));
    const patchClient = track(new Client(clientConfig(DB_NAME)));
    await activationHolder.connect();
    await patchClient.connect();

    await activationHolder.query('BEGIN');
    await activationHolder.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE', [co3]);
    const start3 = new Date();
    const end3 = new Date(start3);
    end3.setUTCMonth(end3.getUTCMonth() + 1);
    await activationHolder.query(
      `INSERT INTO subscriptions
         (company_id, plan, status, currency, period_amount, monthly_price,
          billing_interval, current_period_start, current_period_end, auto_renew, next_billing_date)
       VALUES ($1,'gold','active','USD',67,67,'monthly',$2,$3,false,($3 AT TIME ZONE 'UTC'))`,
      [co3, start3, end3]
    );
    await activationHolder.query("UPDATE companies SET plan='gold', subscription_status='active' WHERE id=$1", [co3]);

    const patchOutcome = { settled: false, error: null, result: null };
    const patchPromise = changePlanOnClient(patchClient, co3, 'bronze');
    patchPromise.then(
      (res) => { patchOutcome.settled = true; patchOutcome.result = res; },
      (err) => { patchOutcome.settled = true; patchOutcome.error = err; }
    );
    const patchBlockedEvidence = await waitForPidBlockedOnLock(monitor, patchClient.processID, patchOutcome);
    check('PATCH was genuinely blocked on the company row while activation was uncommitted', patchBlockedEvidence.locks.length > 0);

    await activationHolder.query('COMMIT');
    const patchResult = await withTimeout(patchPromise, UNBLOCK_TIMEOUT_MS, 'PATCH to refresh managed state after activation committed');
    check('PATCH refreshes managed state after the lock and rejects the conflicting plan change', patchResult.blocked === true);
    const finalCompany3 = await setup.query('SELECT plan FROM companies WHERE id=$1', [co3]);
    const finalSub3 = await setup.query(`SELECT plan FROM subscriptions WHERE company_id=$1 AND status='active'`, [co3]);
    check('activation-first path leaves company and subscription on the activated plan', finalCompany3.rows[0].plan === 'gold' && finalSub3.rows[0].plan === 'gold');

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
