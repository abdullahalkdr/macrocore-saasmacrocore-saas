/**
 * Standalone concurrency proof for Stage B6 (Provider-Neutral Simulated
 * Payment Flow — design pass v5, approved for implementation). Proves the
 * three named cross-operation races (design v5 §11.2-§11.4 / the locked
 * implementation clarifications) execute against REAL PostgreSQL with the
 * REAL controller/service SQL, with explicit lock_timeout/statement_timeout
 * on every connection, and asserts zero 40P01 (deadlock detected) plus the
 * coherent final state for whichever real lock ordering actually occurred.
 *
 * Follows the exact safety/observability conventions established by
 * docs/SMOKE_B1_admin_billing_audit_concurrency.js /
 * docs/SMOKE_B3_invoice_creation_concurrency.js /
 * docs/SMOKE_B5_payment_attempt_concurrency.js — host validation with no
 * default substitution, SMOKE_CONFIRM_DISPOSABLE=yes required, one
 * uniquely-named throwaway database per run, every client closed before
 * DROP DATABASE, a cleanup failure fails the whole run, real
 * pg_stat_activity/pg_locks blocking proof (never inferred from timing).
 *
 * Builds minimal pre-MIGRATION_084 companies/subscriptions/invoices tables
 * matching the same post-MIGRATION_083 shape SMOKE_B5 uses, then executes
 * the REAL MIGRATION_084, MIGRATION_085 and current MIGRATION_086 SQL files —
 * never a hand-copied re-description of them. Applying 086 keeps this B6
 * regression proof runnable against the current settlement code, whose
 * routing query now left-joins the B7 purchase table; all scenarios here
 * remain non-purchase B6 sessions. This is the same "never
 * drift from the artifact production will execute" discipline SMOKE_B5
 * already established, extended across the B5 -> B6 boundary.
 *
 * The settlement side invokes the real exported
 * services/paymentSettlement.ts::resolveCheckoutSessionCore through a thin
 * pg-client adapter. The controller-only createPaymentAttempt,
 * createCheckoutSession, and markPaymentAttemptFailed transaction bodies are
 * reproduced here because their HTTP/audit wrappers are irrelevant to lock
 * behavior; their SQL is executed against PostgreSQL, not searched as source
 * text or mocked. No production constraint
 * or trigger is ever disabled to force a scenario (implementation
 * clarification #3) — every one of the three races below arises from two
 * REAL, uninstrumented transactions colliding on the SAME already-locked
 * invoice row, exactly as MIGRATION_084/085's shared invoice -> attempt ->
 * session lock order was designed to make deadlock-proof (design v5 §3).
 *
 * Scenario A (design v5 §11.2) — createPaymentAttempt vs. resolve('succeeded'):
 *   an existing 'initiated' attempt + 'pending' session on an invoice races
 *   a brand-new createPaymentAttempt call on the SAME invoice against a
 *   concurrent resolve-to-'succeeded' of the existing session. Per the
 *   locked implementation clarification #2, create-attempt must return a
 *   409-equivalent conflict in EITHER lock ordering — never insert a fresh
 *   'initiated' row that coexists with the successful settlement. Analysis:
 *   if resolve wins the invoice lock first, the invoice flips to 'paid'
 *   before create-attempt's own eligibility check ever runs (409 via the
 *   invoice-status check); if create-attempt wins the invoice lock first,
 *   its INSERT collides with the still-'initiated' existing row under
 *   payment_attempts_one_active_per_invoice (23505). Either way: exactly
 *   one attempt ends up 'succeeded', invoice 'paid', zero fresh rows.
 *
 * Scenario B (design v5 §11.3) — createPaymentAttempt vs. markPaymentAttemptFailed:
 *   an existing 'initiated' attempt on an invoice races a brand-new
 *   createPaymentAttempt call on the SAME invoice against a concurrent
 *   markPaymentAttemptFailed of the existing attempt. Unlike Scenario A,
 *   failing an attempt never touches invoices.status — so BOTH lock
 *   orderings are legitimately valid, just different: if markFailed wins
 *   first, create-attempt's later INSERT succeeds (the old row is already
 *   'failed', no longer blocking the partial unique index) and two rows end
 *   up existing (one failed, one freshly initiated); if create-attempt wins
 *   the invoice lock first, its INSERT collides with the still-'initiated'
 *   old row (23505 conflict) and only the original row exists, later marked
 *   'failed'. Both are asserted as coherent outcomes; zero deadlocks either
 *   way, proving the shared lock order actually does its job.
 *
 * Scenario C (design v5 §11.4) — createCheckoutSession vs. markPaymentAttemptFailed:
 *   a fresh 'initiated' attempt with NO session yet races a
 *   createCheckoutSession call against a concurrent markPaymentAttemptFailed
 *   of the same attempt. If createCheckoutSession wins first, a 'pending'
 *   session is created, then markPaymentAttemptFailed's cascade (via
 *   settleOutcome) flips both the attempt AND that session to 'failed'; if
 *   markPaymentAttemptFailed wins first, the attempt is 'failed' with no
 *   session ever created, and createCheckoutSession's own idempotent-replay
 *   check finds nothing and its eligibility check then correctly rejects
 *   (409-equivalent) since the attempt is no longer 'initiated'. Both
 *   orderings leave the attempt 'failed' and, if a session exists at all,
 *   that session 'failed' too — never a 'pending' session orphaned next to
 *   a 'failed' attempt.
 *
 * Each scenario is run TWICE with the two real clients' start order
 * deliberately staggered in opposite directions, biasing (never forcing —
 * this is still a genuine race decided by real PostgreSQL locking, not a
 * scripted interleaving) toward each of the two lock orderings, so both
 * branches of each scenario's analysis get real exercise across the run.
 * Genuine blocking is confirmed via pg_stat_activity/pg_locks whenever the
 * bias produces observable contention.
 *
 * Run with (bash):
 *   SMOKE_CONCURRENCY_ADMIN_URL="postgres://pguser@127.0.0.1:55432/postgres" \
 *   SMOKE_CONFIRM_DISPOSABLE=yes \
 *     node docs/SMOKE_B6_payment_simulator_concurrency.js
 *
 * Point ADMIN_URL at a local/dev Postgres server you control, never at
 * production. The role needs CREATEDB.
 */

const { Client } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('ts-node/register/transpile-only');
const { resolveCheckoutSessionCore } = require('../src/services/paymentSettlement');

const RAW_ADMIN_URL = process.env.SMOKE_CONCURRENCY_ADMIN_URL;
const CONFIRM_DISPOSABLE = process.env.SMOKE_CONFIRM_DISPOSABLE;

const LOCK_POLL_INTERVAL_MS = 100;
const LOCK_POLL_TIMEOUT_MS = 5000;
const MONITOR_QUERY_TIMEOUT_MS = 1000;
const UNBLOCK_TIMEOUT_MS = 5000;
const CLOSE_SETTLE_TIMEOUT_MS = 5000;

// Implementation clarification #4: every concurrency-test connection sets
// explicit lock_timeout/statement_timeout — bounded, never left to
// PostgreSQL's own unbounded defaults, and never inferred from client-side
// timing. Generous enough that a genuinely-blocked party (waiting behind a
// real lock we intend to release) has time to be observed via
// pg_stat_activity before either timeout would fire.
const SESSION_LOCK_TIMEOUT = '3s';
const SESSION_STATEMENT_TIMEOUT = '8s';

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
const DB_NAME = `smoke_b6_concurrency_${RUN_ID}`;
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

// Every scenario connection gets this — real, bounded lock/statement
// timeouts (clarification #4), never PostgreSQL's unbounded defaults.
async function sessionClient(track, dbConfig) {
  const client = track(new Client(dbConfig));
  await client.connect();
  await client.query(`SET lock_timeout = '${SESSION_LOCK_TIMEOUT}'`);
  await client.query(`SET statement_timeout = '${SESSION_STATEMENT_TIMEOUT}'`);
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

// Identical technique to SMOKE_B1/SMOKE_B3 — real, observable proof of lock
// contention via pg_stat_activity/pg_locks, bounded, never inferred from
// client-side timing. Returns null (never throws) if the outcome settles
// before contention was ever observed — callers decide whether that's
// acceptable for a given (best-effort-biased, not forced) ordering attempt.
async function waitForPidBlockedOnLock(monitorClient, pid, outcome) {
  const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (outcome.settled) return null;
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
      if (Date.now() >= deadline) return null;
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
  return null;
}

// --- Faithful copies of the REAL controller/service SQL --------------------

// createPaymentAttempt — unchanged since B5 (see admin.controller.ts). Copied
// verbatim from SMOKE_B5_payment_attempt_concurrency.js's own helper.
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

// createCheckoutSession — B6 (admin.controller.ts). Routing lookup mirrors
// the real controller's own unlocked pre-transaction `pool.query`, then the
// exact same invoice -> attempt -> session lock order, idempotent-replay
// check BEFORE eligibility (correction #8). The allowlist/audit/response
// shaping around this in the real controller is pure JS with no interesting
// Postgres-level behavior — omitted here exactly as SMOKE_B5 omits
// createPaymentAttempt's idempotency-replay JS wrapper.
async function createCheckoutSessionOnClient(client, attemptId) {
  const routing = await client.query(`SELECT invoice_id FROM payment_attempts WHERE id = $1`, [attemptId]);
  const routingRow = routing.rows[0];
  if (!routingRow) return { kind: 'not_found' };

  await client.query('BEGIN');
  const invoiceResult = await client.query(`SELECT id, status FROM invoices WHERE id = $1 FOR UPDATE`, [routingRow.invoice_id]);
  const invoiceRow = invoiceResult.rows[0];
  if (!invoiceRow) {
    await client.query('ROLLBACK');
    return { kind: 'not_found' };
  }
  const attemptResult = await client.query(`SELECT * FROM payment_attempts WHERE id = $1 FOR UPDATE`, [attemptId]);
  const attemptRow = attemptResult.rows[0];
  if (!attemptRow || attemptRow.invoice_id !== routingRow.invoice_id) {
    await client.query('ROLLBACK');
    return { kind: 'not_found' };
  }
  const existingSession = await client.query(
    `SELECT * FROM payment_checkout_sessions WHERE payment_attempt_id = $1 FOR UPDATE`,
    [attemptId]
  );
  if (existingSession.rows[0]) {
    await client.query('COMMIT');
    return { kind: 'replayed', session: existingSession.rows[0] };
  }
  if (attemptRow.status !== 'initiated' || invoiceRow.status !== 'issued') {
    await client.query('ROLLBACK');
    return { kind: 'not_eligible' };
  }
  const insertResult = await client.query(
    `INSERT INTO payment_checkout_sessions (payment_attempt_id, status)
     VALUES ($1, 'pending')
     RETURNING *`,
    [attemptId]
  );
  await client.query('COMMIT');
  return { kind: 'created', session: insertResult.rows[0] };
}

// markPaymentAttemptFailed — B6 rewrite (admin.controller.ts). Same routing
// lookup + invoice -> attempt -> session lock order, then settleOutcome's
// own real UPDATE statements (services/paymentSettlement.ts) inlined
// directly — settleOutcome performs WRITES ONLY with no decision logic of
// its own, so inlining its exact SQL here is a faithful copy, not a
// re-description.
async function markPaymentAttemptFailedOnClient(client, attemptId) {
  const routing = await client.query(`SELECT invoice_id FROM payment_attempts WHERE id = $1`, [attemptId]);
  const routingRow = routing.rows[0];
  if (!routingRow) return { kind: 'not_found' };

  await client.query('BEGIN');
  const invoiceResult = await client.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [routingRow.invoice_id]);
  if (!invoiceResult.rows[0]) {
    await client.query('ROLLBACK');
    return { kind: 'not_found' };
  }
  const attemptResult = await client.query(`SELECT * FROM payment_attempts WHERE id = $1 FOR UPDATE`, [attemptId]);
  const attemptRow = attemptResult.rows[0];
  if (!attemptRow) {
    await client.query('ROLLBACK');
    return { kind: 'not_found' };
  }
  if (attemptRow.status !== 'initiated') {
    await client.query('ROLLBACK');
    return { kind: 'conflict', currentStatus: attemptRow.status };
  }
  const sessionResult = await client.query(
    `SELECT id, status FROM payment_checkout_sessions WHERE payment_attempt_id = $1 FOR UPDATE`,
    [attemptId]
  );
  const sessionRow = sessionResult.rows[0] || null;

  // --- settleOutcome({ outcome: 'failed' }), inlined verbatim ---
  const attemptUpdate = await client.query(
    `UPDATE payment_attempts SET status = $2 WHERE id = $1 RETURNING id, status`,
    [attemptId, 'failed']
  );
  let sessionAfter = null;
  if (sessionRow) {
    const sessionUpdate = await client.query(
      `UPDATE payment_checkout_sessions SET status = $2 WHERE id = $1 RETURNING id, status`,
      [sessionRow.id, 'failed']
    );
    sessionAfter = sessionUpdate.rows[0];
  }
  await client.query('COMMIT');
  return { kind: 'ok', attempt: attemptUpdate.rows[0], session: sessionAfter, sessionExisted: sessionRow != null };
}

// resolveCheckoutSessionCore — the REAL exported TypeScript service, loaded
// through ts-node. The adapter below gives it the two already-configured
// pg Clients this smoke uses for deterministic routing/transaction lock
// observation; no settlement SQL is copied into this script.
async function resolveCheckoutSessionCoreOnClient(routingClient, client, sessionId, outcome) {
  const poolAdapter = {
    query: (sql, params) => routingClient.query(sql, params),
    connect: async () => ({
      query: (sql, params) => client.query(sql, params),
      release: () => {},
    }),
  };
  return resolveCheckoutSessionCore(poolAdapter, sessionId, outcome);
}

// --- 40P01 (deadlock) tracking, across every scenario ----------------------
const deadlockEvents = [];
function noteIfDeadlock(err, where) {
  if (err && err.code === '40P01') {
    deadlockEvents.push({ where, message: err.message });
  }
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

    // Minimal pre-MIGRATION_084 companies/subscriptions/invoices tables,
    // matching the exact post-MIGRATION_083 shape SMOKE_B5 already
    // validated this exact DDL against.
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
        payment_date timestamp,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT invoices_one_invoice_per_period UNIQUE (subscription_id, period_start, period_end),
        CONSTRAINT invoices_number_unique UNIQUE (invoice_number)
      );
    `);

    // Apply the REAL migration files, never a copied/re-described DDL block.
    const migration084Path = path.resolve(__dirname, 'MIGRATION_084_payment_attempt_foundation.sql');
    await setup.query(fs.readFileSync(migration084Path, 'utf8'));
    const migration085Path = path.resolve(__dirname, 'MIGRATION_085_payment_simulator_foundation.sql');
    await setup.query(fs.readFileSync(migration085Path, 'utf8'));
    const migration086Path = path.resolve(__dirname, 'MIGRATION_086_subscription_purchase_foundation.sql');
    await setup.query(fs.readFileSync(migration086Path, 'utf8'));
    // Stage B8: the current settlement code reads
    // subscription_purchases.replaces_subscription_id — apply the REAL 087 too.
    const migration087Path = path.resolve(__dirname, 'MIGRATION_087_subscription_upgrade_foundation.sql');
    await setup.query(fs.readFileSync(migration087Path, 'utf8'));
    console.log('Applied MIGRATION_084, MIGRATION_085, MIGRATION_086 and MIGRATION_087 against the disposable database.');

    const checks = [];
    function check(desc, pass) { checks.push([desc, pass]); console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${desc}`); }
    async function statementFails(sql, params, expectedMessageFragment) {
      try {
        await setup.query(sql, params);
        return false;
      } catch (err) {
        return !expectedMessageFragment || String(err.message).includes(expectedMessageFragment);
      }
    }

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
    async function insertInvoice(companyId, subscriptionId, sub) {
      const issuedAt = new Date();
      const r = await setup.query(
        `INSERT INTO invoices (company_id, subscription_id, plan, billing_interval, currency, amount, period_start, period_end, status, issue_date, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'issued',$9,$9) RETURNING *`,
        [companyId, subscriptionId, sub.plan, sub.billing_interval, sub.currency, sub.period_amount, sub.current_period_start, sub.current_period_end, issuedAt]
      );
      return r.rows[0];
    }
    async function makeIssuedInvoice(label) {
      const co = await insertCompany(label);
      const sub = await insertSubscription(co);
      return insertInvoice(co, sub.id, sub);
    }

    // ========================================================================
    // Schema guards — real MIGRATION_085 triggers/constraints, never disabled
    // ========================================================================
    console.log('\n--- Schema guards: initial state, immutability, terminality, retention, invoice consistency ---');
    const guardInvoice = await makeIssuedInvoice('Schema guard checks');
    const guardAttemptClient = await sessionClient(track, clientConfig(DB_NAME));
    const guardAttempt = await createPaymentAttemptOnClient(guardAttemptClient, guardInvoice.id, 'schema-guard-attempt');

    check(
      'A checkout session cannot be inserted directly in a terminal state',
      await statementFails(
        `INSERT INTO payment_checkout_sessions (payment_attempt_id, status, resolved_at)
         VALUES ($1, 'succeeded', now())`,
        [guardAttempt.id],
        'new rows must start as pending'
      )
    );

    const guardSessionClient = await sessionClient(track, clientConfig(DB_NAME));
    const guardSessionResult = await createCheckoutSessionOnClient(guardSessionClient, guardAttempt.id);
    const guardSession = guardSessionResult.session;
    check('A valid checkout session starts pending with resolved_at unset',
      guardSessionResult.kind === 'created' && guardSession.status === 'pending' && guardSession.resolved_at == null);

    const guardResolveRoutingClient = await sessionClient(track, clientConfig(DB_NAME));
    const guardResolveClient = await sessionClient(track, clientConfig(DB_NAME));
    const guardResolution = await resolveCheckoutSessionCoreOnClient(
      guardResolveRoutingClient,
      guardResolveClient,
      guardSession.id,
      'cancelled'
    );
    check('The real settlement service resolves attempt + session to cancelled atomically', guardResolution.kind === 'ok');

    const guardRows = await setup.query(
      `SELECT pa.status AS attempt_status, pa.cancelled_at, pa.failed_at, pa.succeeded_at,
              pcs.status AS session_status, pcs.resolved_at
       FROM payment_attempts pa
       JOIN payment_checkout_sessions pcs ON pcs.payment_attempt_id = pa.id
       WHERE pa.id = $1`,
      [guardAttempt.id]
    );
    check(
      'Cancelled terminal timestamps are database-stamped and mutually exclusive',
      guardRows.rows[0].attempt_status === 'cancelled' && guardRows.rows[0].cancelled_at != null &&
      guardRows.rows[0].failed_at == null && guardRows.rows[0].succeeded_at == null &&
      guardRows.rows[0].session_status === 'cancelled' && guardRows.rows[0].resolved_at != null
    );
    check(
      'A terminal checkout session rejects repeated/same-state transitions',
      await statementFails(
        `UPDATE payment_checkout_sessions SET status = 'cancelled' WHERE id = $1`,
        [guardSession.id],
        'transition cancelled -> cancelled is not permitted'
      )
    );
    check(
      'Checkout-session provider/identity fields are immutable',
      await statementFails(
        `UPDATE payment_checkout_sessions SET provider = 'other' WHERE id = $1`,
        [guardSession.id],
        'columns are immutable'
      )
    );
    check(
      'Checkout-session financial history is append-only',
      await statementFails(
        `DELETE FROM payment_checkout_sessions WHERE id = $1`,
        [guardSession.id],
        'append-only'
      )
    );
    check(
      'Payment-attempt money snapshots remain immutable after B6',
      await statementFails(
        `UPDATE payment_attempts SET amount = amount + 0.001 WHERE id = $1`,
        [guardAttempt.id],
        'columns are immutable'
      )
    );
    check(
      'Payment-attempt financial history remains append-only after B6',
      await statementFails(
        `DELETE FROM payment_attempts WHERE id = $1`,
        [guardAttempt.id],
        'append-only'
      )
    );
    check(
      'An invoice referenced by a payment attempt remains deletion-restricted',
      await statementFails(
        `DELETE FROM invoices WHERE id = $1`,
        [guardInvoice.id],
        'payment_attempts_invoice_company_subscription_fk'
      )
    );

    const consistencyInvoice = await makeIssuedInvoice('Invoice paid/date consistency');
    check(
      'An issued invoice cannot gain payment_date without becoming paid',
      await statementFails(
        `UPDATE invoices SET payment_date = now() WHERE id = $1`,
        [consistencyInvoice.id],
        'invoices_payment_date_consistency'
      )
    );
    check(
      'An invoice cannot become paid without payment_date in the same statement',
      await statementFails(
        `UPDATE invoices SET status = 'paid' WHERE id = $1`,
        [consistencyInvoice.id],
        'invoices_payment_date_consistency'
      )
    );

    // Fresh session creation has two independent eligibility requirements:
    // the attempt must still be initiated AND the invoice must still be
    // issued. Existing sessions are replayed before this check, but a paid
    // invoice with no prior session must never gain a new checkout session.
    console.log('\n--- Eligibility guard: no fresh checkout session on a paid invoice ---');
    const paidInvoice = await makeIssuedInvoice('Paid invoice eligibility guard');
    const paidInvoiceAttemptClient = await sessionClient(track, clientConfig(DB_NAME));
    const paidInvoiceAttempt = await createPaymentAttemptOnClient(
      paidInvoiceAttemptClient,
      paidInvoice.id,
      'paid-invoice-no-session'
    );
    await setup.query(
      `UPDATE invoices SET status = 'paid', payment_date = now() WHERE id = $1`,
      [paidInvoice.id]
    );
    const paidInvoiceSessionClient = await sessionClient(track, clientConfig(DB_NAME));
    const paidInvoiceSession = await createCheckoutSessionOnClient(paidInvoiceSessionClient, paidInvoiceAttempt.id);
    check(
      'Fresh checkout-session creation rejects an initiated attempt whose invoice is already paid',
      paidInvoiceSession.kind === 'not_eligible'
    );
    const paidInvoiceSessionCount = await setup.query(
      `SELECT count(*)::int AS n FROM payment_checkout_sessions WHERE payment_attempt_id = $1`,
      [paidInvoiceAttempt.id]
    );
    check(
      'Rejected paid-invoice creation leaves no partial payment_checkout_sessions row',
      paidInvoiceSessionCount.rows[0].n === 0
    );

    // ==========================================================================
    // Scenario A (design v5 §11.2) — createPaymentAttempt vs. resolve('succeeded')
    // ==========================================================================
    console.log('\n--- Scenario A: createPaymentAttempt vs. resolve(succeeded) on the SAME invoice, both real lock orderings ---');

    async function runScenarioA(label, staggerCreateFirst) {
      const invoice = await makeIssuedInvoice(`Scenario A ${label}`);
      const existingAttempt = await createPaymentAttemptOnClient(
        await sessionClient(track, clientConfig(DB_NAME)), invoice.id, `scenario-a-${label}-original`
      );
      const sessionSetup = await createCheckoutSessionOnClient(
        await sessionClient(track, clientConfig(DB_NAME)), existingAttempt.id
      );
      if (sessionSetup.kind !== 'created') throw new Error(`Scenario A ${label} setup: expected a created session, got ${sessionSetup.kind}`);
      const existingSession = sessionSetup.session;

      const monitor = await sessionClient(track, clientConfig(DB_NAME));
      const createClient = await sessionClient(track, clientConfig(DB_NAME));
      const resolveClient = await sessionClient(track, clientConfig(DB_NAME));
      const resolveRoutingClient = await sessionClient(track, clientConfig(DB_NAME));

      const createOutcome = { settled: false, error: null, result: null };
      const resolveOutcome = { settled: false, error: null, result: null };

      function launchCreate() {
        const p = createPaymentAttemptOnClient(createClient, invoice.id, `scenario-a-${label}-race`);
        p.then((r) => { createOutcome.settled = true; createOutcome.result = r; }, (e) => { createOutcome.settled = true; createOutcome.error = e; });
        return p;
      }
      function launchResolve() {
        const p = resolveCheckoutSessionCoreOnClient(resolveRoutingClient, resolveClient, existingSession.id, 'succeeded');
        p.then((r) => { resolveOutcome.settled = true; resolveOutcome.result = r; }, (e) => { resolveOutcome.settled = true; resolveOutcome.error = e; });
        return p;
      }

      let createPromise, resolvePromise;
      if (staggerCreateFirst) {
        createPromise = launchCreate();
        await new Promise((r) => setTimeout(r, 30)); // brief head start to acquire the invoice lock first
        resolvePromise = launchResolve();
        await waitForPidBlockedOnLock(monitor, resolveClient.processID, resolveOutcome).catch(() => {});
      } else {
        resolvePromise = launchResolve();
        await new Promise((r) => setTimeout(r, 30));
        createPromise = launchCreate();
        await waitForPidBlockedOnLock(monitor, createClient.processID, createOutcome).catch(() => {});
      }

      const [createResult, resolveResult] = await Promise.allSettled([
        withTimeout(createPromise, UNBLOCK_TIMEOUT_MS, `Scenario A ${label} create-attempt to settle`),
        withTimeout(resolvePromise, UNBLOCK_TIMEOUT_MS, `Scenario A ${label} resolve to settle`),
      ]);

      if (createResult.status === 'rejected') noteIfDeadlock(createResult.reason, `Scenario A ${label} create-attempt`);
      if (resolveResult.status === 'rejected') noteIfDeadlock(resolveResult.reason, `Scenario A ${label} resolve`);

      check(
        `Scenario A (${label}): resolve(succeeded) always completes 'ok' (never blocked into a conflict by the racing create-attempt)`,
        resolveResult.status === 'fulfilled' && resolveResult.value.kind === 'ok'
      );
      check(
        `Scenario A (${label}): createPaymentAttempt NEVER succeeds while racing a to-'succeeded' resolve — rejects in either lock ordering, either via the 23505 one-active-per-invoice conflict (create-attempt won the invoice lock first) or via the 409 invoice-not-eligible check (resolve won the invoice lock first and already flipped the invoice to 'paid')`,
        createResult.status === 'rejected' && createResult.reason &&
        (createResult.reason.isConflict === true || createResult.reason.isNotEligible === true)
      );

      const finalAttempts = await setup.query(
        `SELECT status FROM payment_attempts WHERE invoice_id = $1 ORDER BY created_at`,
        [invoice.id]
      );
      const finalInvoice = await setup.query(`SELECT status FROM invoices WHERE id = $1`, [invoice.id]);
      check(
        `Scenario A (${label}): exactly one payment_attempts row exists for the invoice afterward, and it is 'succeeded'`,
        finalAttempts.rows.length === 1 && finalAttempts.rows[0].status === 'succeeded'
      );
      check(`Scenario A (${label}): the invoice is 'paid'`, finalInvoice.rows[0].status === 'paid');

      return { orderingBiasedTowardCreateFirst: staggerCreateFirst };
    }

    await runScenarioA('bias-create-first', true);
    await runScenarioA('bias-resolve-first', false);

    // ==========================================================================
    // Scenario B (design v5 §11.3) — createPaymentAttempt vs. markPaymentAttemptFailed
    // ==========================================================================
    console.log('\n--- Scenario B: createPaymentAttempt vs. markPaymentAttemptFailed on the SAME invoice, both real lock orderings ---');

    async function runScenarioB(label, staggerCreateFirst) {
      const invoice = await makeIssuedInvoice(`Scenario B ${label}`);
      const existingAttempt = await createPaymentAttemptOnClient(
        await sessionClient(track, clientConfig(DB_NAME)), invoice.id, `scenario-b-${label}-original`
      );

      const monitor = await sessionClient(track, clientConfig(DB_NAME));
      const createClient = await sessionClient(track, clientConfig(DB_NAME));
      const failClient = await sessionClient(track, clientConfig(DB_NAME));

      const createOutcome = { settled: false, error: null, result: null };
      const failOutcome = { settled: false, error: null, result: null };

      function launchCreate() {
        const p = createPaymentAttemptOnClient(createClient, invoice.id, `scenario-b-${label}-race`);
        p.then((r) => { createOutcome.settled = true; createOutcome.result = r; }, (e) => { createOutcome.settled = true; createOutcome.error = e; });
        return p;
      }
      function launchFail() {
        const p = markPaymentAttemptFailedOnClient(failClient, existingAttempt.id);
        p.then((r) => { failOutcome.settled = true; failOutcome.result = r; }, (e) => { failOutcome.settled = true; failOutcome.error = e; });
        return p;
      }

      let createPromise, failPromise;
      if (staggerCreateFirst) {
        createPromise = launchCreate();
        await new Promise((r) => setTimeout(r, 30));
        failPromise = launchFail();
        await waitForPidBlockedOnLock(monitor, failClient.processID, failOutcome).catch(() => {});
      } else {
        failPromise = launchFail();
        await new Promise((r) => setTimeout(r, 30));
        createPromise = launchCreate();
        await waitForPidBlockedOnLock(monitor, createClient.processID, createOutcome).catch(() => {});
      }

      const [createResult, failResult] = await Promise.allSettled([
        withTimeout(createPromise, UNBLOCK_TIMEOUT_MS, `Scenario B ${label} create-attempt to settle`),
        withTimeout(failPromise, UNBLOCK_TIMEOUT_MS, `Scenario B ${label} markFailed to settle`),
      ]);

      if (createResult.status === 'rejected') noteIfDeadlock(createResult.reason, `Scenario B ${label} create-attempt`);
      if (failResult.status === 'rejected') noteIfDeadlock(failResult.reason, `Scenario B ${label} markFailed`);

      check(
        `Scenario B (${label}): markPaymentAttemptFailed always completes 'ok' (invoices.status is never touched by a failure, so it can never itself be blocked into a conflict)`,
        failResult.status === 'fulfilled' && failResult.value.kind === 'ok'
      );

      const finalAttempts = await setup.query(
        `SELECT id, status FROM payment_attempts WHERE invoice_id = $1 ORDER BY created_at`,
        [invoice.id]
      );
      const originalRow = finalAttempts.rows.find((r) => r.id === existingAttempt.id);
      check(`Scenario B (${label}): the ORIGINAL attempt ends up 'failed' regardless of which real ordering occurred`, originalRow && originalRow.status === 'failed');

      if (createResult.status === 'fulfilled') {
        check(
          `Scenario B (${label}) [markFailed-won-first branch]: create-attempt's fresh row exists and is 'initiated'`,
          finalAttempts.rows.length === 2 && createResult.value && createResult.value.status === 'initiated'
        );
      } else {
        check(
          `Scenario B (${label}) [create-attempt-won-first branch]: create-attempt rejected as a 23505 conflict on the one-active-per-invoice constraint, and only the original row exists`,
          createResult.reason && createResult.reason.isConflict === true && createResult.reason.code === '23505' &&
          finalAttempts.rows.length === 1
        );
      }
      // Invariant that must hold regardless of which branch occurred: at most
      // one 'initiated' row per invoice, ever (the partial unique index's own
      // job) — checked directly here as an end-to-end proof, not merely
      // trusted from the constraint's existence.
      const initiatedCount = finalAttempts.rows.filter((r) => r.status === 'initiated').length;
      check(`Scenario B (${label}): never more than one 'initiated' attempt coexists for the invoice`, initiatedCount <= 1);

      return { branch: createResult.status === 'fulfilled' ? 'markFailed-won-first' : 'create-attempt-won-first' };
    }

    const bBias1 = await runScenarioB('bias-create-first', true);
    const bBias2 = await runScenarioB('bias-resolve-first', false);
    check(
      'Scenario B: both real lock orderings (markFailed-won-first and create-attempt-won-first) were exercised across the two staggered runs',
      new Set([bBias1.branch, bBias2.branch]).size === 2
    );

    // ==========================================================================
    // Scenario C (design v5 §11.4) — createCheckoutSession vs. markPaymentAttemptFailed
    // ==========================================================================
    console.log('\n--- Scenario C: createCheckoutSession vs. markPaymentAttemptFailed on the SAME (session-less) attempt, both real lock orderings ---');

    async function runScenarioC(label, staggerCreateFirst) {
      const invoice = await makeIssuedInvoice(`Scenario C ${label}`);
      const attempt = await createPaymentAttemptOnClient(
        await sessionClient(track, clientConfig(DB_NAME)), invoice.id, `scenario-c-${label}-original`
      );

      const monitor = await sessionClient(track, clientConfig(DB_NAME));
      const createSessionClient = await sessionClient(track, clientConfig(DB_NAME));
      const failClient = await sessionClient(track, clientConfig(DB_NAME));

      const createOutcome = { settled: false, error: null, result: null };
      const failOutcome = { settled: false, error: null, result: null };

      function launchCreateSession() {
        const p = createCheckoutSessionOnClient(createSessionClient, attempt.id);
        p.then((r) => { createOutcome.settled = true; createOutcome.result = r; }, (e) => { createOutcome.settled = true; createOutcome.error = e; });
        return p;
      }
      function launchFail() {
        const p = markPaymentAttemptFailedOnClient(failClient, attempt.id);
        p.then((r) => { failOutcome.settled = true; failOutcome.result = r; }, (e) => { failOutcome.settled = true; failOutcome.error = e; });
        return p;
      }

      let createPromise, failPromise;
      if (staggerCreateFirst) {
        createPromise = launchCreateSession();
        await new Promise((r) => setTimeout(r, 30));
        failPromise = launchFail();
        await waitForPidBlockedOnLock(monitor, failClient.processID, failOutcome).catch(() => {});
      } else {
        failPromise = launchFail();
        await new Promise((r) => setTimeout(r, 30));
        createPromise = launchCreateSession();
        await waitForPidBlockedOnLock(monitor, createSessionClient.processID, createOutcome).catch(() => {});
      }

      const [createResult, failResult] = await Promise.allSettled([
        withTimeout(createPromise, UNBLOCK_TIMEOUT_MS, `Scenario C ${label} createCheckoutSession to settle`),
        withTimeout(failPromise, UNBLOCK_TIMEOUT_MS, `Scenario C ${label} markFailed to settle`),
      ]);

      if (createResult.status === 'rejected') noteIfDeadlock(createResult.reason, `Scenario C ${label} createCheckoutSession`);
      if (failResult.status === 'rejected') noteIfDeadlock(failResult.reason, `Scenario C ${label} markFailed`);

      check(
        `Scenario C (${label}): both operations settle without throwing (createCheckoutSession returns a discriminated result, never an exception, for either branch)`,
        createResult.status === 'fulfilled' && failResult.status === 'fulfilled'
      );
      check(`Scenario C (${label}): markPaymentAttemptFailed always completes 'ok'`, failResult.status === 'fulfilled' && failResult.value.kind === 'ok');

      const finalAttempt = await setup.query(`SELECT status FROM payment_attempts WHERE id = $1`, [attempt.id]);
      check(`Scenario C (${label}): the attempt ends up 'failed' regardless of which real ordering occurred`, finalAttempt.rows[0].status === 'failed');

      const finalSessions = await setup.query(`SELECT status FROM payment_checkout_sessions WHERE payment_attempt_id = $1`, [attempt.id]);
      let branch;
      if (createResult.status === 'fulfilled' && createResult.value.kind === 'created') {
        branch = 'createSession-won-first';
        check(
          `Scenario C (${label}) [createSession-won-first branch]: exactly one session exists and it was cascaded to 'failed' by markPaymentAttemptFailed's own settleOutcome — never left 'pending'`,
          finalSessions.rows.length === 1 && finalSessions.rows[0].status === 'failed'
        );
      } else {
        branch = 'markFailed-won-first';
        check(
          `Scenario C (${label}) [markFailed-won-first branch]: createCheckoutSession correctly found the attempt no longer 'initiated' and no existing session — 'not_eligible', and NO session was ever created`,
          createResult.value && createResult.value.kind === 'not_eligible' && finalSessions.rows.length === 0
        );
      }

      return { branch };
    }

    const cBias1 = await runScenarioC('bias-create-first', true);
    const cBias2 = await runScenarioC('bias-resolve-first', false);
    check(
      'Scenario C: both real lock orderings (createSession-won-first and markFailed-won-first) were exercised across the two staggered runs',
      new Set([cBias1.branch, cBias2.branch]).size === 2
    );

    // ==========================================================================
    // Cross-cutting: zero deadlocks across every scenario, every ordering
    // ==========================================================================
    check(
      `Zero 40P01 (deadlock detected) errors across all scenarios and both real lock orderings of each (observed: ${deadlockEvents.length})`,
      deadlockEvents.length === 0
    );
    if (deadlockEvents.length > 0) {
      for (const ev of deadlockEvents) console.error(`  DEADLOCK at ${ev.where}: ${ev.message}`);
    }

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
