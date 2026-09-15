/**
 * Standalone concurrency proof for Stage B1 (admin.controller.ts's
 * updateCompany() — atomic before/after audit snapshot for
 * PATCH /api/admin/companies/:id).
 *
 * HISTORICAL NOTE: this proves the single-statement implementation released
 * in B1 commit cbd52b8. Stage B2 later changed updateCompany() to an explicit
 * transaction so its managed-subscription check sees state committed by an
 * activation it waited behind. Use SMOKE_B2_subscription_activation_concurrency.js
 * for the current controller's concurrency proof. This script remains useful
 * only as reproducible evidence for the accepted B1 implementation.
 *
 * Round 3 correction: the previous version of this script inferred commit
 * order from Date.now() timestamps taken after each client call resolved.
 * That is NOT proof of database lock contention — client-side response
 * timing can tie, can be reordered by the event loop / network jitter, and
 * Promise.all() racing two queries proves nothing about what happened inside
 * Postgres. This version instead:
 *   1. Opens connection A, starts an explicit transaction, and runs
 *      updateCompany's exact CTE UPDATE — this genuinely acquires and HOLDS
 *      the row lock (no COMMIT yet).
 *   2. Opens connection B and fires the SAME UPDATE at the SAME row without
 *      awaiting it yet.
 *   3. Polls pg_stat_activity (a third, separate monitoring connection) for
 *      connection B's backend PID to show wait_event_type = 'Lock' — the
 *      actual, observable proof that B is blocked waiting on A's lock — with
 *      a bounded timeout. If B is never observed blocked within that bound,
 *      the script FAILS loudly instead of silently treating that as success.
 *   4. Only THEN commits A, then awaits B (now unblocked).
 *   5. Asserts A's and B's exact previous/current snapshots and the final row.
 *
 * This is a TEST HARNESS technique only (an explicit BEGIN held open by the
 * test to force contention). It describes the historical B1 controller at
 * cbd52b8, not the Stage B2 implementation currently in the working tree.
 *
 * Further correction (this pass) — ChatGPT inspected the actual delivered
 * files and found the round-3-so-far version of this script still had four
 * concrete bugs, fixed here:
 *   1. Host validation had a silent default: `parsedConfig.host || 'localhost'`.
 *      `pg`'s OWN host resolution (see pg/lib/connection-parameters.js's
 *      `val()` helper) checks the config object, THEN process.env.PGHOST,
 *      and only THEN falls back to a hardcoded default — in that order. So a
 *      hostless connection string (e.g. "postgres:///postgres") combined
 *      with a non-local PGHOST set in this process's environment would have
 *      been silently APPROVED by that old validation as "localhost", while
 *      `pg` itself would actually have connected to whatever PGHOST said.
 *      Fixed: no default substitution at all — the host must be explicitly
 *      present in the connection string. Narrowed acceptance to exactly
 *      'localhost' or '127.0.0.1' (dropping the previous '::1' and
 *      unix-socket allowances — the simplest safe surface for a disposable
 *      smoke tool). The check runs during parsing, before any Client is
 *      constructed or any connection attempted.
 *   2. Every Client connecting to the throwaway database now reuses ONE
 *      validated structured config object (spread from the same parsed
 *      config `pg-connection-string` already produced) instead of
 *      `buildDbUrl()` manually reconstructing a connection-string URL by
 *      hand — the old approach could mishandle accepted forms and silently
 *      dropped other connection fields (ssl, options, etc.) that
 *      `parsedConfig` may have carried.
 *   3. Client B's query promise now has a rejection handler attached the
 *      instant it is issued (not after the lock-polling step) — an early
 *      failure from B can no longer become an unhandled promise rejection
 *      that could crash the process before cleanup runs. B's outcome is
 *      tracked and checked by the poll loop itself, which now also wraps
 *      each individual monitoring query in a bounded timeout, not just the
 *      overall polling loop.
 *   4. A `DROP DATABASE` failure during cleanup now makes the whole script
 *      exit nonzero, in addition to being logged — it no longer prints a
 *      warning and then reports success.
 *
 * SAFETY: this script actively refuses to run against anything that doesn't
 * look like a local, disposable Postgres instance:
 *   - Reads ONLY its own env var, SMOKE_CONCURRENCY_ADMIN_URL — never
 *     DATABASE_URL, never any .env file (no dotenv, no process.cwd() reads).
 *   - Parses the connection string with the same library `pg` itself uses
 *     (pg-connection-string) and validates the EFFECTIVE host — including a
 *     `?host=...` query-string override, which pg-connection-string honors
 *     and which a bare substring check on the URL would miss entirely.
 *     Requires an EXPLICIT host equal to 'localhost' or '127.0.0.1' — no
 *     default is ever substituted for a missing host, and nothing else
 *     (a real hostname, a cloud DB endpoint, '::1', a unix-socket path) is
 *     accepted.
 *   - Requires a SEPARATE, explicit env var (SMOKE_CONFIRM_DISPOSABLE=yes)
 *     acknowledging the target instance is disposable — a local-looking host
 *     alone is not treated as sufficient confirmation.
 *   - Creates one uniquely-named throwaway database for this run only, never
 *     touches any existing table, and drops ONLY that same database (a flag
 *     is set only after CREATE DATABASE actually succeeds; DROP is never
 *     attempted otherwise). If the DROP itself fails, the script reports
 *     that failure AND exits nonzero — it never reports success while the
 *     disposable database is left behind.
 *   - Every client is closed in a finally block, including on a query
 *     failure — and all client connections to the throwaway database are
 *     confirmed closed (with a bounded wait, falling back to
 *     pg_terminate_backend against ONLY that database's PIDs) before the
 *     DROP DATABASE is attempted, since Postgres refuses to drop a database
 *     with open connections.
 *   - Never prints a raw connection string or password — only a redacted
 *     form (host/port/db only) appears in any log or error output.
 *
 * Run with (bash):
 *   SMOKE_CONCURRENCY_ADMIN_URL="postgres://postgres:yourpassword@127.0.0.1:5432/postgres" \
 *   SMOKE_CONFIRM_DISPOSABLE=yes \
 *     node docs/SMOKE_B1_admin_billing_audit_concurrency.js
 *
 * Run with (Windows PowerShell):
 *   $env:SMOKE_CONCURRENCY_ADMIN_URL = "postgres://postgres:yourpassword@127.0.0.1:5432/postgres"
 *   $env:SMOKE_CONFIRM_DISPOSABLE = "yes"
 *   node docs/SMOKE_B1_admin_billing_audit_concurrency.js
 *
 * Point ADMIN_URL at a local/dev Postgres server you control (its "postgres"
 * or another admin-privileged maintenance database — NOT your app's own
 * database), never at production. The role needs CREATEDB. Only run this
 * against an isolated, disposable Postgres instance you already have — this
 * script does not install or provision Postgres itself.
 */

const { Client } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');
const crypto = require('crypto');

const RAW_ADMIN_URL = process.env.SMOKE_CONCURRENCY_ADMIN_URL;
const CONFIRM_DISPOSABLE = process.env.SMOKE_CONFIRM_DISPOSABLE;

const LOCK_POLL_INTERVAL_MS = 100;
const LOCK_POLL_TIMEOUT_MS = 5000;
const MONITOR_QUERY_TIMEOUT_MS = 1000; // per-query bound inside the poll loop, capped further by remaining budget
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
  fail("Set SMOKE_CONFIRM_DISPOSABLE=yes to explicitly confirm the target Postgres instance is a disposable one you control. A local-looking hostname alone is not treated as confirmation.");
}

// Parse with the SAME library `pg` itself uses to build a connection config,
// so a query-string override (?host=...) that pg would honor is caught here
// too — a plain substring/regex check on the raw URL text would miss this.
let parsedConfig;
try {
  parsedConfig = parseConnectionString(RAW_ADMIN_URL);
} catch (e) {
  fail('Could not parse SMOKE_CONCURRENCY_ADMIN_URL as a Postgres connection string.');
}

// `pg`'s own ConnectionParameters resolves a missing host as:
//   config.host  ->  process.env.PGHOST  ->  pg's hardcoded default
// in that order (see node_modules/pg/lib/connection-parameters.js's `val()`
// helper). So treating a missing host here as 'localhost' (the previous bug)
// would validate against a value `pg` might never actually use — if PGHOST
// is set to something non-local in this process's environment, a hostless
// connection string would be silently approved while `pg` connects
// elsewhere. Fix: no default substitution at all. The host must be present,
// explicitly, in the connection string itself. This check is pure string
// parsing — it runs before any Client is constructed and before any network
// connection is attempted.
const rawHost = parsedConfig.host; // deliberately NOT `|| 'localhost'`
if (!rawHost) {
  const pgHostEnv = process.env.PGHOST;
  fail(
    `SMOKE_CONCURRENCY_ADMIN_URL has no explicit host (e.g. "postgres:///postgres"). This script never ` +
    `substitutes a default, because \`pg\` itself would resolve the missing host from ` +
    `process.env.PGHOST${pgHostEnv ? ` (currently set to "${pgHostEnv}" in this process's environment)` : ' (or its own built-in default, if PGHOST is also unset)'} ` +
    `— a value this script has no way to validate on your behalf. Put an explicit host in the connection ` +
    `string itself, e.g. "postgres://user:pass@localhost:5432/postgres" or "...@127.0.0.1:5432/postgres".`
  );
}
// Simplest safe surface for a disposable smoke tool: only these two exact
// forms are accepted. This is narrower than what `pg`/Postgres would treat
// as "local" (no '::1', no unix-domain-socket path) — deliberately, since
// this script only needs to work against a Postgres started the normal way
// on the same machine.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
if (!LOCAL_HOSTS.has(rawHost)) {
  fail(`Connection host is "${rawHost}" (after applying any query-string override), which is not one of the two forms this script accepts (localhost, 127.0.0.1). Refusing to run against anything else.`);
}
const effectiveHost = rawHost;

function redacted(cfg) {
  return `postgres://${cfg.user || '(default)'}:***@${effectiveHost}:${cfg.port || 5432}/${cfg.database || '(default)'}`;
}

console.log(`Target (redacted): ${redacted(parsedConfig)}`);

const RUN_ID = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const DB_NAME = `smoke_b1_concurrency_${RUN_ID}`;
let dbCreated = false; // only set true once CREATE DATABASE actually succeeds

// One validated structured config object, reused (with only `database`
// overridden) for every Client this script opens — never a manually
// rebuilt connection-string URL. `parsedConfig` is exactly what
// pg-connection-string produced from SMOKE_CONCURRENCY_ADMIN_URL, and pg's
// own ConnectionParameters constructor accepts this same shape directly, so
// there is no re-serialization step that could drop fields (ssl, options,
// etc.) or mishandle a value — the bug the previous buildDbUrl() had.
function clientConfig(dbName) {
  return { ...parsedConfig, host: effectiveHost, database: dbName };
}

function updateSql(sets, idParamIndex) {
  // Copied verbatim (structure-wise) from admin.controller.ts's updateCompany.
  // If that query ever changes shape, update this to match.
  return `WITH previous AS (
       SELECT id, plan, subscription_status, trial_end_date
       FROM companies
       WHERE id = $${idParamIndex}
       FOR UPDATE
     )
     UPDATE companies
     SET ${sets.join(', ')}
     FROM previous
     WHERE companies.id = previous.id
     RETURNING companies.id, companies.name, companies.plan, companies.subscription_status, companies.trial_end_date,
               previous.plan AS previous_plan, previous.subscription_status AS previous_subscription_status,
               previous.trial_end_date AS previous_trial_end_date`;
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

// Polls pg_stat_activity for the given backend pid to show it genuinely
// blocked on a lock (wait_event_type = 'Lock') -- the actual, observable
// proof of contention this review asked for, not an elapsed-time inference.
// Bounded overall by LOCK_POLL_TIMEOUT_MS, AND each individual monitoring
// query inside the loop is separately bounded (a single hung poll query can
// no longer stall this function past the overall deadline, since the outer
// while-loop's Date.now() check only runs BETWEEN iterations). `bOutcome` is
// checked every iteration so this returns/throws promptly if B settles on
// its own instead of waiting out the full timeout.
async function waitForPidBlockedOnLock(monitorClient, pid, bOutcome) {
  const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (bOutcome.settled) {
      if (bOutcome.error) {
        throw new Error(`B's query failed before contention could be observed/confirmed: ${bOutcome.error.message}`);
      }
      throw new Error(
        `B's query completed WITHOUT ever being observed blocked on a lock. This means A's FOR UPDATE did ` +
        `not actually serialize against B -- no real contention occurred -- so the concurrency proof is ` +
        `INVALID, not merely "not yet confirmed".`
      );
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
  throw new Error(
    `Never observed backend pid ${pid} blocked on a lock (wait_event_type = 'Lock') within ${LOCK_POLL_TIMEOUT_MS}ms. ` +
    `This means real contention was NOT confirmed -- treat the concurrency proof as FAILED/inconclusive, not passed.`
  );
}

async function closeAndWait(client, label) {
  if (!client) return;
  try {
    await withTimeout(client.end(), CLOSE_SETTLE_TIMEOUT_MS, `closing ${label}`);
  } catch (e) {
    console.error(`Warning: error closing ${label}: ${e.message}`);
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

  // Every client opened against the throwaway DB, tracked so we can force-close
  // all of them (even on a failure path) before attempting DROP DATABASE.
  const openClients = [];
  function track(client) {
    openClients.push(client);
    return client;
  }

  let companyId;
  try {
    const setup = track(new Client(clientConfig(DB_NAME)));
    try {
      await setup.connect();
      await setup.query(`
        CREATE TABLE companies (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name text NOT NULL DEFAULT 'Smoke Test Co',
          plan text NOT NULL DEFAULT 'trial',
          subscription_status text NOT NULL DEFAULT 'trial',
          trial_end_date timestamptz
        );
      `);
      companyId = (
        await setup.query(`INSERT INTO companies (name, plan, subscription_status) VALUES ('Smoke Test Co', 'trial', 'trial') RETURNING id`)
      ).rows[0].id;
    } finally {
      await closeAndWait(setup, 'setup connection');
    }

    const monitor = track(new Client(clientConfig(DB_NAME)));
    const clientA = track(new Client(clientConfig(DB_NAME)));
    const clientB = track(new Client(clientConfig(DB_NAME)));
    await monitor.connect();
    await clientA.connect();
    await clientB.connect();

    const pidA = clientA.processID;
    const pidB = clientB.processID;

    let rowA, rowB, blockedEvidence;
    try {
      // 1. A takes and HOLDS the row lock inside an explicit transaction --
      //    this test-harness-only BEGIN is what makes contention deterministic
      //    to observe; it is never how the real controller runs.
      await clientA.query('BEGIN');
      const resA = await clientA.query(updateSql(['plan = $1'], 2), ['gold', companyId]);
      rowA = resA.rows[0];

      // 2. B fires the SAME update at the SAME row. Attach a rejection
      //    handler THE INSTANT the query is issued -- not after the
      //    lock-polling step below. Without this, an early failure from B
      //    (e.g. its connection drops) would be an unhandled promise
      //    rejection for the entire window between now and whenever we
      //    finally get around to awaiting bPromise, which can crash the
      //    whole process before any cleanup code ever runs. bOutcome lets
      //    the poll loop below notice B settling on its own and react
      //    immediately instead of waiting out the full lock-poll timeout.
      const bOutcome = { settled: false, error: null, result: null };
      const bPromise = clientB.query(updateSql(['subscription_status = $1'], 2), ['suspended', companyId]);
      bPromise.then(
        (res) => { bOutcome.settled = true; bOutcome.result = res; },
        (err) => { bOutcome.settled = true; bOutcome.error = err; }
      );

      // 3. Prove B is actually blocked on a lock, via Postgres's own
      //    observability views, with a bounded timeout -- not by inferring
      //    it from elapsed time. This also throws (with a specific message)
      //    if B settles -- successfully or not -- before ever being observed
      //    blocked, instead of masking that as a plain timeout.
      blockedEvidence = await waitForPidBlockedOnLock(monitor, pidB, bOutcome);

      // 4. Only now commit A, releasing the lock, then await B (bounded).
      //    bPromise already has a handler attached above; awaiting it again
      //    here to get its resolved value is safe.
      await clientA.query('COMMIT');
      const resB = await withTimeout(bPromise, UNBLOCK_TIMEOUT_MS, 'B to complete after A committed');
      rowB = resB.rows[0];
    } catch (e) {
      // Make sure A's transaction doesn't linger open on any failure path.
      try { await clientA.query('ROLLBACK'); } catch (_) { /* best-effort */ }
      throw e;
    }

    const checks = [];
    checks.push(['A (the lock holder) saw the seed row (trial/trial) as its previous state',
      rowA.previous_plan === 'trial' && rowA.previous_subscription_status === 'trial']);
    // Note: waitForPidBlockedOnLock() above already THROWS (aborting the whole
    // run) if B was never observed blocked within the timeout -- reaching this
    // line at all means contention was confirmed. This check additionally
    // asserts pg_locks actually returned rows for B at that moment (real data
    // captured, not an empty/placeholder result).
    checks.push(["B was genuinely blocked on a Postgres lock while A's transaction was open (pg_stat_activity.wait_event_type = 'Lock', confirmed via polling with a bounded timeout, not inferred from client-side timing)",
      blockedEvidence.locks.length > 0]);
    checks.push(['B (unblocked only after A committed) correctly saw A\'s committed change (plan=gold) as its own previous state -- real serialization proven by lock contention, not a lost update',
      rowB.previous_plan === 'gold' && rowB.previous_subscription_status === 'trial']);

    const verify = track(new Client(clientConfig(DB_NAME)));
    await verify.connect();
    const finalRow = (await verify.query('SELECT plan, subscription_status FROM companies WHERE id = $1', [companyId])).rows[0];
    checks.push(['final row has BOTH concurrent changes applied (plan=gold AND subscription_status=suspended) -- no dirty overwrite',
      finalRow.plan === 'gold' && finalRow.subscription_status === 'suspended']);

    console.log('\nLock evidence from pg_locks for B while blocked:', JSON.stringify(blockedEvidence.locks));
    console.log('\nFINAL ROW:', finalRow);
    console.log('\nCHECKS:');
    let allPass = true;
    for (const [desc, pass] of checks) {
      console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${desc}`);
      if (!pass) allPass = false;
    }
    exitCode = allPass ? 0 : 1;
  } finally {
    // Close every client opened against the throwaway DB -- Postgres refuses
    // to DROP DATABASE while any session is still connected to it.
    for (const c of openClients) {
      await closeAndWait(c, 'test connection');
    }

    if (dbCreated) {
      const cleanup = new Client(clientConfig(parsedConfig.database));
      try {
        await cleanup.connect();
        // Safety net: force-terminate anything still (unexpectedly) connected
        // to our throwaway database before dropping it, rather than letting
        // DROP DATABASE fail and leak the database.
        await cleanup.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [DB_NAME]
        );
        await cleanup.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
        console.log(`Cleanup: dropped ${DB_NAME}`);
      } catch (e) {
        // A cleanup failure is NOT just a warning -- it must fail the run.
        // Reporting success (exit 0) while the disposable database is left
        // behind would be a false "all clear".
        cleanupFailed = true;
        console.error(
          `CLEANUP FAILED: could not confirm ${DB_NAME} was dropped (${e.message}). ` +
          `It may still exist and require manual cleanup: DROP DATABASE ${DB_NAME};`
        );
      } finally {
        await closeAndWait(cleanup, 'admin (cleanup) connection');
      }
    }
  }

  if (cleanupFailed) {
    exitCode = exitCode === 0 ? 1 : exitCode;
  }
  process.exit(exitCode);
}

main().catch((e) => {
  // Never print the raw connection string / password -- only the error message.
  console.error('ERROR:', e.message);
  process.exit(2);
});
