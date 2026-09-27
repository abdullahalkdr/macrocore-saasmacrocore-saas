/* eslint-disable no-console */
/**
 * SMOKE_B8_2_expired_purchase_cleanup.js — Stage B8.2 real-PostgreSQL smoke.
 * Design: claude/chat8c-b8-2-expired-purchase-cleanup-design-pass-v3-2026-09-27.md
 * (§4, §5, §6, §7, §8, §10.4–§10.5; test matrix §12).
 *
 * Creates THREE disposable databases on a local PostgreSQL server you control:
 *   <main>      — core, race, budget and replica tests (real services + triggers)
 *   <main>_prov — the provider CHECK is dropped there ONLY, to prove the
 *                 provider tripwire (design §12.4 X3) and PREFLIGHT_B8_2 P3
 *   <main>_pre  — a clean database for the PREFLIGHT_B8_2 snapshot / post-deploy
 *                 comparison tests (§12.5 L9)
 * builds each schema through MIGRATION_087 from the real files, runs the real
 * services against them, then drops all three. A cleanup failure fails the run.
 *
 * Never reads DATABASE_URL or any .env file. RESEND_API_KEY is forced empty and
 * no email is delivered (nothing here runs the email worker). Only localhost /
 * 127.0.0.1 targets are accepted. Snapshot files go to the OS temp directory
 * and are deleted afterwards.
 *
 * Run with (bash):
 *   SMOKE_CONCURRENCY_ADMIN_URL="postgres://pguser@127.0.0.1:55432/postgres" \
 *   SMOKE_CONFIRM_DISPOSABLE=yes \
 *     node docs/SMOKE_B8_2_expired_purchase_cleanup.js
 *
 * Optional: SMOKE_B8_2_ITERATIONS (default 5). The role needs CREATEDB and
 * superuser (fixtures use session_replication_role; the _prov database drops a
 * CHECK constraint).
 */

const { Client, Pool } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RAW_ADMIN_URL = process.env.SMOKE_CONCURRENCY_ADMIN_URL;
const CONFIRM_DISPOSABLE = process.env.SMOKE_CONFIRM_DISPOSABLE;
const ITERATIONS = Number.parseInt(process.env.SMOKE_B8_2_ITERATIONS || '5', 10);

function fail(msg) {
  console.error(`REFUSING TO RUN: ${msg}`);
  process.exit(1);
}
if (!RAW_ADMIN_URL) fail('SMOKE_CONCURRENCY_ADMIN_URL is not set. This script never reads DATABASE_URL or any .env file — set this one explicitly.');
if (/DATABASE_URL/i.test(RAW_ADMIN_URL)) fail('SMOKE_CONCURRENCY_ADMIN_URL looks like an unexpanded shell reference, not a real connection string.');
if (CONFIRM_DISPOSABLE !== 'yes') fail('Set SMOKE_CONFIRM_DISPOSABLE=yes to explicitly confirm the target Postgres instance is a disposable one you control.');
let parsedConfig;
try {
  parsedConfig = parseConnectionString(RAW_ADMIN_URL);
} catch (e) {
  fail('Could not parse SMOKE_CONCURRENCY_ADMIN_URL as a Postgres connection string.');
}
const rawHost = parsedConfig.host;
if (!rawHost) fail('SMOKE_CONCURRENCY_ADMIN_URL has no explicit host. This script never substitutes a default.');
if (!new Set(['localhost', '127.0.0.1']).has(rawHost)) fail(`Connection host is "${rawHost}", not one of (localhost, 127.0.0.1). Refusing to run against anything else.`);

const RUN_ID = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const DB_NAME = `smoke_b8_2_cleanup_${RUN_ID}`;
const DB_PROV = `${DB_NAME}_prov`;
const DB_PRE = `${DB_NAME}_pre`;
const port = parsedConfig.port || 5432;
const userPart = parsedConfig.user ? `${encodeURIComponent(parsedConfig.user)}${parsedConfig.password ? `:${encodeURIComponent(parsedConfig.password)}` : ''}@` : '';
const dbUrl = (db, opts = '-c lock_timeout=8000 -c statement_timeout=20000') => `postgres://${userPart}${rawHost}:${port}/${db}?options=${encodeURIComponent(opts)}`;
const APP_DB_URL = dbUrl(DB_NAME);
console.log(`Target (redacted): postgres://${parsedConfig.user || '(default)'}:***@${rawHost}:${port}/${DB_NAME}{,_prov,_pre}`);

process.env.DATABASE_URL = APP_DB_URL;
process.env.JWT_SECRET = 'smoke-b8-2-only-fake-jwt-secret-not-real';
process.env.ENABLE_BACKGROUND_SWEEPS = 'true';
process.env.ENABLE_EXPIRED_PURCHASE_CLEANUP = 'true';
process.env.RESEND_API_KEY = '';
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = 'https://app.example.test';

const BACKEND_DIR = path.resolve(__dirname, '..');
const PREFLIGHT = path.join(__dirname, 'PREFLIGHT_B8_2_expired_purchase_cleanup_check.js');
const clientConfig = (dbName) => ({ ...parsedConfig, host: rawHost, database: dbName });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadlocks = [];
function noteIfDeadlock(err, where) {
  if (err && err.code === '40P01') deadlocks.push({ where, message: err.message });
}
const checks = [];
function check(desc, pass, detail) {
  checks.push([desc, !!pass]);
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${desc}${!pass && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}

async function buildSchema(setup) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  await setup.query(fs.readFileSync(path.join(repoRoot, 'docs', 'DATABASE_SCHEMA.sql'), 'utf8'));
  const migrations = fs.readdirSync(__dirname).filter((f) => /^MIGRATION_0\d\d_.*\.sql$/.test(f)).sort();
  for (const file of migrations) {
    if (file >= 'MIGRATION_086') continue;
    await setup.query(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  }
  await setup.query(fs.readFileSync(path.join(__dirname, 'MIGRATION_086_subscription_purchase_foundation.sql'), 'utf8'));
  await setup.query(fs.readFileSync(path.join(__dirname, 'MIGRATION_087_subscription_upgrade_foundation.sql'), 'utf8'));
}

// A Connectable over one dedicated client whose statements can be observed,
// delayed and fault-injected: hooks[sqlPrefix] = async (sql) => void | throws.
function hookedConnectable(client, hooks = {}) {
  const query = async (sql, params) => {
    for (const [prefix, fn] of Object.entries(hooks)) {
      if (typeof sql === 'string' && sql.startsWith(prefix)) await fn(sql);
    }
    return client.query(sql, params);
  };
  return { query, connect: async () => ({ query, release: () => {} }) };
}

function runPreflight(dbName, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [PREFLIGHT, ...args], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl(dbName, '-c statement_timeout=20000'), ...extraEnv },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

async function main() {
  const admin = new Client(clientConfig(parsedConfig.database));
  await admin.connect();
  const created = [];
  try {
    console.log(`PostgreSQL server: ${(await admin.query('SELECT version()')).rows[0].version}`);
    for (const db of [DB_NAME, DB_PROV, DB_PRE]) {
      await admin.query(`CREATE DATABASE ${db}`);
      created.push(db);
    }
  } finally {
    await admin.end();
  }

  const openClients = [];
  const track = (c) => { openClients.push(c); return c; };
  const extraPools = [];
  let appPool = null;
  let exitCode = 1;
  const tmpFiles = [];

  try {
    const setup = track(new Client(clientConfig(DB_NAME)));
    await setup.connect();
    await buildSchema(setup);
    for (const db of [DB_PROV, DB_PRE]) {
      const c = new Client(clientConfig(db));
      await c.connect();
      await buildSchema(c);
      await c.end();
    }
    console.log('Built the schema through MIGRATION_087 (real files) in all three disposable databases.');

    require('ts-node/register/transpile-only');
    const sp = require('../src/services/subscriptionPurchase');
    const cleanup = require('../src/services/expiredPurchaseCleanup');
    const { resolveCheckoutSessionCore } = require('../src/services/paymentSettlement');
    const emailUtils = require('../src/utils/email');
    const { catalogPriceText } = require('../src/config/planCatalog');
    const { pool } = require('../src/db/pool');
    appPool = pool;

    // ---------------------------------------------------------------- helpers
    const mk = (db) => {
      const q1 = async (sql, params) => (await db.query(sql, params)).rows[0];
      const rows = async (sql, params) => (await db.query(sql, params)).rows;
      async function newCompany(label, overrides = {}) {
        return (await db.query(`INSERT INTO companies (name, plan, subscription_status) VALUES ($1, $2, $3) RETURNING id`,
          [label, overrides.plan || 'trial', overrides.subscription_status || 'trial'])).rows[0].id;
      }
      async function addUser(co, email) {
        return (await db.query(`INSERT INTO users (company_id, email, role, status, preferred_language) VALUES ($1, $2, 'admin', 'active', 'en') RETURNING id`, [co, email])).rows[0].id;
      }
      async function makePaid(label, plan = 'bronze', interval = 'monthly') {
        const co = await newCompany(label, { plan, subscription_status: 'active' });
        const sub = (await db.query(
          `WITH c AS (SELECT clock_timestamp() AS t)
           INSERT INTO subscriptions (company_id, plan, status, currency, period_amount, monthly_price, billing_interval,
                                      current_period_start, current_period_end, auto_renew, next_billing_date)
           SELECT $1, $2, 'active', 'USD', $3::numeric, $3::numeric, $4, c.t,
                  ((c.t AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC', false,
                  ((c.t AT TIME ZONE 'UTC') + interval '1 month')
           FROM c RETURNING id`,
          [co, plan, catalogPriceText(plan, interval), interval])).rows[0];
        return { co, src: sub.id };
      }
      // Replica-mode fixture write (bypasses guard triggers; CHECKs still apply).
      async function fixture(sql, params) {
        await db.query('BEGIN');
        await db.query(`SET LOCAL session_replication_role = replica`);
        await db.query(sql, params);
        await db.query('COMMIT');
      }
      const expire = (id) => fixture(`UPDATE subscription_purchases SET expires_at = created_at + interval '1 millisecond' WHERE id = $1`, [id]);
      const expireIn = (id, ms) => fixture(`UPDATE subscription_purchases SET expires_at = clock_timestamp() + make_interval(secs => $2::double precision / 1000) WHERE id = $1`, [id, ms]);
      const neutralize = (id) => fixture(`UPDATE subscription_purchases SET expires_at = clock_timestamp() + interval '1 year' WHERE id = $1`, [id]);
      // Full JSON fingerprint of a purchase chain + its company + email/audit counts.
      async function fingerprint(purchaseId) {
        return JSON.stringify((await db.query(
          `SELECT row_to_json(sp) AS p,
                  (SELECT row_to_json(s) FROM subscriptions s WHERE s.id = sp.subscription_id) AS pending,
                  (SELECT row_to_json(s) FROM subscriptions s WHERE s.id = sp.replaces_subscription_id) AS source,
                  (SELECT row_to_json(i) FROM invoices i WHERE i.id = sp.invoice_id) AS inv,
                  (SELECT json_agg(row_to_json(a) ORDER BY a.created_at, a.id) FROM payment_attempts a WHERE a.invoice_id = sp.invoice_id) AS attempts,
                  (SELECT json_agg(row_to_json(ps) ORDER BY ps.id) FROM payment_checkout_sessions ps JOIN payment_attempts a ON a.id = ps.payment_attempt_id WHERE a.invoice_id = sp.invoice_id) AS sessions,
                  (SELECT row_to_json(c) FROM companies c WHERE c.id = sp.company_id) AS company,
                  (SELECT count(*) FROM email_jobs ej WHERE ej.company_id = sp.company_id) AS jobs,
                  (SELECT count(*) FROM audit_logs al WHERE al.company_id = sp.company_id) AS audits
           FROM subscription_purchases sp WHERE sp.id = $1`, [purchaseId])).rows[0]);
      }
      const statusOf = (id) => q1(
        `SELECT sp.status AS purchase, s.status AS pending, i.status AS invoice, i.payment_date,
                (SELECT status FROM subscriptions WHERE id = sp.replaces_subscription_id) AS source
         FROM subscription_purchases sp JOIN subscriptions s ON s.id = sp.subscription_id JOIN invoices i ON i.id = sp.invoice_id WHERE sp.id = $1`, [id]);
      const attemptsOf = (id) => rows(
        `SELECT a.id, a.status, a.failed_at, a.cancelled_at, ps.id AS session_id, ps.status AS session_status, ps.resolved_at
         FROM subscription_purchases sp JOIN payment_attempts a ON a.invoice_id = sp.invoice_id
         LEFT JOIN payment_checkout_sessions ps ON ps.payment_attempt_id = a.id WHERE sp.id = $1 ORDER BY a.created_at, a.id`, [id]);
      const cleanupAudits = (id) => rows(
        `SELECT user_id, ip_address, user_agent, new_values FROM audit_logs WHERE entity_type = 'subscription_purchases' AND entity_id = $1 AND action = 'subscription_purchase_voided'`, [id]);
      return { q1, rows, newCompany, addUser, makePaid, fixture, expire, expireIn, neutralize, fingerprint, statusOf, attemptsOf, cleanupAudits };
    };
    const h = mk(setup);
    const { q1, rows } = h;

    const trialConfirm = (co, plan = 'silver', interval = 'monthly', db = pool) =>
      sp.confirmPurchase(db, { companyId: co, plan, interval, currency: 'USD', amountText: catalogPriceText(plan, interval) });
    const upgrade = (co, src, plan = 'silver', interval = 'monthly', db = pool) =>
      sp.confirmPurchase(db, { companyId: co, plan, interval, currency: 'USD', amountText: catalogPriceText(plan, interval), expectedSourceSubscriptionId: src });
    const one = (id, co, db = pool) => cleanup.cleanupOneExpiredPurchase(db, { id, company_id: co });
    const quiet = async (fn) => {
      const saved = [console.log, console.error, console.warn];
      console.log = () => {};
      console.error = () => {};
      console.warn = () => {};
      try {
        return await fn();
      } finally {
        [console.log, console.error, console.warn] = saved;
      }
    };
    const openExpiredCount = async () => (await q1(`SELECT count(*)::int AS n FROM subscription_purchases WHERE status = 'open' AND expires_at <= clock_timestamp()`)).n;
    const confirmationJobsForNonCompleted = async () => (await q1(
      `SELECT count(*)::int AS n FROM email_jobs ej JOIN subscription_purchases sp ON starts_with(ej.dedup_key, 'billing:purchase_confirmed:' || sp.id::text || ':') WHERE sp.status <> 'completed'`)).n;
    const startDeadlocks = Number((await q1(`SELECT deadlocks FROM pg_stat_database WHERE datname = $1`, [DB_NAME])).deadlocks);
    const insertAttemptWithoutSession = (purchaseId) => setup.query(
      `INSERT INTO payment_attempts (invoice_id, company_id, subscription_id, amount, currency, plan, billing_interval, period_start, period_end, idempotency_key)
       SELECT i.id, i.company_id, i.subscription_id, i.amount, i.currency, i.plan, i.billing_interval, i.period_start, i.period_end, 'smoke-b82-' || gen_random_uuid()
       FROM invoices i JOIN subscription_purchases sp ON sp.invoice_id = i.id WHERE sp.id = $1 RETURNING id`, [purchaseId]);

    // ======================================================================
    console.log('\n== C — core cleanup behaviour (design v3 §4, §12.1) ==');
    // C1 / C5 / C10 — trial, no attempts, trial state + trial email job preserved.
    const coT = await h.newCompany('Private Trial Name Co');
    const uT = await h.addUser(coT, 'private.person@example.test');
    await emailUtils.insertEmailJob(setup, {
      to: 'private.person@example.test', subject: 's', html: '<p>h</p>', category: 'billing', lang: 'en',
      dedupKey: `billing:trial_ending:${coT}:2026-10-01T00:00:00.000000Z:${uT}`, companyId: coT, relatedEntityType: 'companies', relatedEntityId: coT,
    });
    const pT = await trialConfirm(coT);
    await h.expire(pT.purchaseId);
    const companyBefore = await q1(`SELECT row_to_json(c)::text AS j FROM companies c WHERE id = $1`, [coT]);
    const jobsBefore = await rows(`SELECT id, status, dedup_key FROM email_jobs WHERE company_id = $1 ORDER BY id`, [coT]);
    const rT = await quiet(() => one(pT.purchaseId, coT));
    const sT = await h.statusOf(pT.purchaseId);
    check('C1: expired trial purchase -> voided; invoice void (no payment_date); pending sub abandoned',
      rT.outcome === 'voided' && sT.purchase === 'void' && sT.invoice === 'void' && sT.payment_date === null && sT.pending === 'abandoned', { rT: rT.outcome, sT });
    check('C5: company row byte-identical (trial state and trial dates preserved)',
      (await q1(`SELECT row_to_json(c)::text AS j FROM companies c WHERE id = $1`, [coT])).j === companyBefore.j);
    const jobsAfter = await rows(`SELECT id, status, dedup_key FROM email_jobs WHERE company_id = $1 ORDER BY id`, [coT]);
    check('C5/C10: trial email job untouched; no email_jobs row created by the cleanup',
      JSON.stringify(jobsAfter) === JSON.stringify(jobsBefore) && jobsAfter.length === 1 && jobsAfter[0].status === 'queued');
    const aT = await h.cleanupAudits(pT.purchaseId);
    check('C10: exactly one audit row — reason expired_cleanup, system actor, user/ip/user-agent NULL, no PII',
      aT.length === 1 && aT[0].new_values.reason === 'expired_cleanup' && aT[0].new_values.actor === 'system_expired_purchase_cleanup' &&
      aT[0].user_id === null && aT[0].ip_address === null && aT[0].user_agent === null &&
      !JSON.stringify(aT[0].new_values).includes('private') && !JSON.stringify(aT[0].new_values).includes('@'), aT);

    // C2 — initiated attempt + pending session.
    const coC2 = await h.newCompany('C2');
    const pC2 = await trialConfirm(coC2);
    await sp.startCheckout(pool, coC2, pC2.purchaseId);
    await h.expire(pC2.purchaseId);
    const rC2 = await quiet(() => one(pC2.purchaseId, coC2));
    const atC2 = await h.attemptsOf(pC2.purchaseId);
    check('C2: initiated attempt + pending session -> both cancelled with DB stamps',
      rC2.outcome === 'voided' && atC2.length === 1 && atC2[0].status === 'cancelled' && atC2[0].cancelled_at && atC2[0].session_status === 'cancelled' && atC2[0].resolved_at, atC2);

    // C3 — initiated attempt with no session (admin createPaymentAttempt shape).
    const coC3 = await h.newCompany('C3');
    const pC3 = await trialConfirm(coC3);
    await insertAttemptWithoutSession(pC3.purchaseId);
    await h.expire(pC3.purchaseId);
    const rC3 = await quiet(() => one(pC3.purchaseId, coC3));
    const atC3 = await h.attemptsOf(pC3.purchaseId);
    check('C3: initiated attempt without a session -> attempt cancelled',
      rC3.outcome === 'voided' && atC3.length === 1 && atC3[0].status === 'cancelled' && atC3[0].session_id === null, atC3);

    // C4 — upgrade: the source row and the company are byte-identical.
    const { co: coU, src: srcU } = await h.makePaid('Upgrade Co');
    const pU = await upgrade(coU, srcU, 'gold');
    await sp.startCheckout(pool, coU, pU.purchaseId);
    await h.expire(pU.purchaseId);
    const srcBefore = await q1(`SELECT row_to_json(s)::text AS j FROM subscriptions s WHERE id = $1`, [srcU]);
    const coUBefore = await q1(`SELECT row_to_json(c)::text AS j FROM companies c WHERE id = $1`, [coU]);
    const rU = await quiet(() => one(pU.purchaseId, coU));
    check('C4: expired upgrade -> voided; source subscription (all 14 columns) and company byte-identical; source still active',
      rU.outcome === 'voided' &&
      (await q1(`SELECT row_to_json(s)::text AS j FROM subscriptions s WHERE id = $1`, [srcU])).j === srcBefore.j &&
      (await q1(`SELECT row_to_json(c)::text AS j FROM companies c WHERE id = $1`, [coU])).j === coUBefore.j &&
      (await h.statusOf(pU.purchaseId)).source === 'active');
    check('C4: upgrade audit row carries replaces_subscription_id', (await h.cleanupAudits(pU.purchaseId))[0]?.new_values.replaces_subscription_id === srcU);

    // C6 — completed purchase (paid invoice) is never selected / touched.
    const coDone = await h.newCompany('Completed Co');
    const pDone = await trialConfirm(coDone);
    const cDone = await sp.startCheckout(pool, coDone, pDone.purchaseId);
    await resolveCheckoutSessionCore(pool, cDone.sessionId, 'succeeded');
    await h.fixture(`UPDATE subscription_purchases SET expires_at = created_at + interval '1 millisecond' WHERE id = $1`, [pDone.purchaseId]);
    const fpDone = await h.fingerprint(pDone.purchaseId);
    const candidatesAll = await cleanup.selectExpiredCandidates(pool, 1000, null);
    const rDone = await quiet(() => one(pDone.purchaseId, coDone));
    check('C6: completed purchase (paid invoice, expires_at in the past) is never a candidate; direct call -> skipped_resolved, zero writes',
      !candidatesAll.some((c) => c.id === pDone.purchaseId) && rDone.outcome === 'skipped_resolved' && (await h.fingerprint(pDone.purchaseId)) === fpDone);

    // C7 — a lazily voided (superseded) purchase is never selected / touched.
    const coSup = await h.newCompany('Superseded Co');
    const pSup1 = await trialConfirm(coSup, 'silver');
    await trialConfirm(coSup, 'gold');
    const fpSup = await h.fingerprint(pSup1.purchaseId);
    const rSup = await quiet(() => one(pSup1.purchaseId, coSup));
    check('C7: void (superseded) purchase -> skipped_resolved, zero writes', rSup.outcome === 'skipped_resolved' && (await h.fingerprint(pSup1.purchaseId)) === fpSup);
    const pSup2 = (await q1(`SELECT id FROM subscription_purchases WHERE company_id = $1 AND status = 'open'`, [coSup])).id;

    // C8 — unexpired: not a candidate; direct call decides on the post-lock clock.
    const fpUnexp = await h.fingerprint(pSup2);
    const rUnexp = await quiet(() => one(pSup2, coSup));
    check('C8: unexpired open purchase -> not a candidate; direct call -> skipped_not_expired, zero writes',
      !(await cleanup.selectExpiredCandidates(pool, 1000, null)).some((c) => c.id === pSup2) && rUnexp.outcome === 'skipped_not_expired' && (await h.fingerprint(pSup2)) === fpUnexp);

    // C11 — failed + cancelled attempts with matching sessions stay untouched.
    const coC11 = await h.newCompany('C11');
    const pC11 = await trialConfirm(coC11);
    const k1 = await sp.startCheckout(pool, coC11, pC11.purchaseId);
    await resolveCheckoutSessionCore(pool, k1.sessionId, 'failed');
    const k2 = await sp.startCheckout(pool, coC11, pC11.purchaseId);
    await resolveCheckoutSessionCore(pool, k2.sessionId, 'cancelled');
    await sp.startCheckout(pool, coC11, pC11.purchaseId);
    const before11 = await h.attemptsOf(pC11.purchaseId);
    await h.expire(pC11.purchaseId);
    const rC11 = await quiet(() => one(pC11.purchaseId, coC11));
    const after11 = await h.attemptsOf(pC11.purchaseId);
    check('C11: failed/failed and cancelled/cancelled pairs unchanged (stamps identical); only the initiated attempt + pending session cancelled',
      rC11.outcome === 'voided' && after11.length === 3 &&
      JSON.stringify(after11.slice(0, 2)) === JSON.stringify(before11.slice(0, 2)) &&
      after11[2].status === 'cancelled' && after11[2].session_status === 'cancelled', { before11, after11 });

    // C12–C15 — anomalies: zero writes, the right class, and the purchase stays open.
    const anomalyCases = [
      ['C12: failed attempt + pending session -> anomaly_session', 'anomaly_session', async (pid) => {
        await h.fixture(`UPDATE payment_attempts SET status = 'failed', failed_at = clock_timestamp() WHERE invoice_id = (SELECT invoice_id FROM subscription_purchases WHERE id = $1)`, [pid]);
      }],
      ['C13: cancelled attempt + failed session -> anomaly_session', 'anomaly_session', async (pid) => {
        await h.fixture(`UPDATE payment_attempts SET status = 'cancelled', cancelled_at = clock_timestamp() WHERE invoice_id = (SELECT invoice_id FROM subscription_purchases WHERE id = $1)`, [pid]);
        await h.fixture(`UPDATE payment_checkout_sessions SET status = 'failed', resolved_at = clock_timestamp() WHERE payment_attempt_id IN (SELECT a.id FROM payment_attempts a JOIN subscription_purchases sp ON sp.invoice_id = a.invoice_id WHERE sp.id = $1)`, [pid]);
      }],
      ['C13b: cancelled attempt + pending session -> anomaly_session', 'anomaly_session', async (pid) => {
        await h.fixture(`UPDATE payment_attempts SET status = 'cancelled', cancelled_at = clock_timestamp() WHERE invoice_id = (SELECT invoice_id FROM subscription_purchases WHERE id = $1)`, [pid]);
      }],
      ['C15a: initiated attempt + cancelled session -> anomaly_session', 'anomaly_session', async (pid) => {
        await h.fixture(`UPDATE payment_checkout_sessions SET status = 'cancelled', resolved_at = clock_timestamp() WHERE payment_attempt_id IN (SELECT a.id FROM payment_attempts a JOIN subscription_purchases sp ON sp.invoice_id = a.invoice_id WHERE sp.id = $1)`, [pid]);
      }],
      ['C14: succeeded attempt -> anomaly_attempt (paid-looking chain never voided)', 'anomaly_attempt', async (pid) => {
        await h.fixture(`UPDATE payment_attempts SET status = 'succeeded', succeeded_at = clock_timestamp() WHERE invoice_id = (SELECT invoice_id FROM subscription_purchases WHERE id = $1)`, [pid]);
        await h.fixture(`UPDATE payment_checkout_sessions SET status = 'succeeded', resolved_at = clock_timestamp() WHERE payment_attempt_id IN (SELECT a.id FROM payment_attempts a JOIN subscription_purchases sp ON sp.invoice_id = a.invoice_id WHERE sp.id = $1)`, [pid]);
      }],
      ['C15b: pending subscription not pending_payment -> anomaly_pending', 'anomaly_pending', async (pid) => {
        await h.fixture(`UPDATE subscriptions SET status = 'abandoned' WHERE id = (SELECT subscription_id FROM subscription_purchases WHERE id = $1)`, [pid]);
      }],
      ['C15c: invoice already paid -> anomaly_invoice (paid invoice never voided)', 'anomaly_invoice', async (pid) => {
        await h.fixture(`UPDATE invoices SET status = 'paid', payment_date = clock_timestamp() WHERE id = (SELECT invoice_id FROM subscription_purchases WHERE id = $1)`, [pid]);
      }],
    ];
    const anomalyIds = [];
    for (const [label, cls, corrupt] of anomalyCases) {
      const co = await h.newCompany(label.slice(0, 20));
      const p = await trialConfirm(co);
      await sp.startCheckout(pool, co, p.purchaseId);
      await corrupt(p.purchaseId);
      await h.expire(p.purchaseId);
      const fp = await h.fingerprint(p.purchaseId);
      const r = await quiet(() => one(p.purchaseId, co));
      check(`${label}, zero writes`, r.outcome === cls && (await h.fingerprint(p.purchaseId)) === fp, r);
      anomalyIds.push([p.purchaseId, co]);
    }
    // C15d — upgrade whose source is no longer active -> anomaly_source.
    {
      const { co, src } = await h.makePaid('Source past_due');
      const p = await upgrade(co, src, 'gold');
      await h.fixture(`UPDATE subscriptions SET status = 'past_due' WHERE id = $1`, [src]);
      await h.expire(p.purchaseId);
      const fp = await h.fingerprint(p.purchaseId);
      const r = await quiet(() => one(p.purchaseId, co));
      check('C15d: upgrade source not active -> anomaly_source, zero writes', r.outcome === 'anomaly_source' && (await h.fingerprint(p.purchaseId)) === fp, r);
      anomalyIds.push([p.purchaseId, co]);
    }
    // Lazy path fail-closed: a confirm over an anomalous open purchase rolls back entirely.
    {
      const [pid, co] = anomalyIds[0];
      const fp = await h.fingerprint(pid);
      const openBefore = (await q1(`SELECT count(*)::int AS n FROM subscription_purchases WHERE company_id = $1`, [co])).n;
      let err = null;
      try {
        await trialConfirm(co, 'gold');
      } catch (e) {
        err = e;
      }
      check('lazy confirm over an anomalous chain -> PurchaseChainAnomaly, full rollback (no new purchase, zero writes)',
        err instanceof sp.PurchaseChainAnomaly && (await h.fingerprint(pid)) === fp &&
        (await q1(`SELECT count(*)::int AS n FROM subscription_purchases WHERE company_id = $1`, [co])).n === openBefore, err && err.message);
    }
    for (const [pid] of anomalyIds) await h.neutralize(pid);

    // ======================================================================
    console.log('\n== R — races and post-lock deadlines (design v3 §7, §12.2) ==');
    // R1 / R4 — success holds the company first with the gate passing.
    {
      const co = await h.newCompany('R1');
      const p = await trialConfirm(co);
      const c = await sp.startCheckout(pool, co, p.purchaseId);
      await h.expireIn(p.purchaseId, 4000);
      const blocker = track(new Client(clientConfig(DB_NAME)));
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [co]);
      const settle = resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded');
      await sleep(150);
      const busy = await quiet(() => one(p.purchaseId, co));
      await blocker.query('COMMIT');
      const r = await settle;
      await sleep(4200);
      const after = await quiet(() => one(p.purchaseId, co));
      const replay = await resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded');
      check('R1: cleanup while success waits on the company -> skipped_busy; success (gate passed) completes; later cleanup -> skipped_resolved',
        busy.outcome === 'skipped_busy' && r.kind === 'ok' && after.outcome === 'skipped_resolved' && (await h.statusOf(p.purchaseId)).invoice === 'paid', { busy, r: r.kind, after });
      check('R4: success replay after completion -> 409; the completed purchase is never a candidate',
        replay.kind === 'conflict' && !(await cleanup.selectExpiredCandidates(pool, 1000, null)).some((x) => x.id === p.purchaseId));
    }
    // R2 / X2 / R5b — cleanup first, then stale simulator callbacks.
    {
      const co = await h.newCompany('R2');
      const p = await trialConfirm(co);
      const c = await sp.startCheckout(pool, co, p.purchaseId);
      await h.expire(p.purchaseId);
      await quiet(() => one(p.purchaseId, co));
      const fp = await h.fingerprint(p.purchaseId);
      const results = [];
      for (const outcome of ['succeeded', 'failed', 'cancelled']) results.push(await resolveCheckoutSessionCore(pool, c.sessionId, outcome));
      check('R2/X2/R5: stale succeeded/failed/cancelled callbacks after cleanup -> 409 conflict, zero writes, no confirmation job',
        results.every((x) => x.kind === 'conflict') && (await h.fingerprint(p.purchaseId)) === fp && (await confirmationJobsForNonCompleted()) === 0, results.map((x) => x.kind));
    }
    // R3 — success starts BEFORE the deadline and waits on the company lock held by cleanup past it.
    {
      const co = await h.newCompany('R3');
      const p = await trialConfirm(co);
      const c = await sp.startCheckout(pool, co, p.purchaseId);
      await h.expireIn(p.purchaseId, 1200);
      const conn = track(new Client(clientConfig(DB_NAME)));
      await conn.connect();
      const db = hookedConnectable(conn, {
        'SELECT id, company_id, subscription_id, invoice_id, status, replaces_subscription_id': async () => sleep(2000),
      });
      const cleaning = cleanup.cleanupOneExpiredPurchase(db, { id: p.purchaseId, company_id: co });
      await sleep(200); // cleanup holds the company lock now; the deadline has not passed yet
      const beforeDeadline = (await q1(`SELECT clock_timestamp() < expires_at AS u FROM subscription_purchases WHERE id = $1`, [p.purchaseId])).u;
      const settling = resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded');
      const [rc, rs] = await Promise.all([quiet(() => cleaning), settling]);
      check('R3: success started before the deadline, waited on the cleanup-held company lock past it -> cleanup voided, success 409, zero success writes',
        beforeDeadline === true && rc.outcome === 'voided' && rs.kind === 'conflict' && (await h.statusOf(p.purchaseId)).purchase === 'void' &&
        (await confirmationJobsForNonCompleted()) === 0, { beforeDeadline, rc: rc.outcome, rs });
    }
    // R12 — the deadline passes while cleanup waits on EACH chain lock.
    for (const target of ['source', 'pending', 'invoice', 'attempt', 'session']) {
      const { co, src } = await h.makePaid(`R12 ${target}`);
      const p = await upgrade(co, src, 'gold');
      await sp.startCheckout(pool, co, p.purchaseId);
      await h.expireIn(p.purchaseId, 800);
      const lockSql = {
        source: [`SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE`, src],
        pending: [`SELECT s.id FROM subscriptions s JOIN subscription_purchases sp ON sp.subscription_id = s.id WHERE sp.id = $1 FOR UPDATE OF s`, p.purchaseId],
        invoice: [`SELECT i.id FROM invoices i JOIN subscription_purchases sp ON sp.invoice_id = i.id WHERE sp.id = $1 FOR UPDATE OF i`, p.purchaseId],
        attempt: [`SELECT a.id FROM payment_attempts a JOIN subscription_purchases sp ON sp.invoice_id = a.invoice_id WHERE sp.id = $1 FOR UPDATE OF a`, p.purchaseId],
        session: [`SELECT ps.id FROM payment_checkout_sessions ps JOIN payment_attempts a ON a.id = ps.payment_attempt_id JOIN subscription_purchases sp ON sp.invoice_id = a.invoice_id WHERE sp.id = $1 FOR UPDATE OF ps`, p.purchaseId],
      }[target];
      const blocker = track(new Client(clientConfig(DB_NAME)));
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query(lockSql[0], [lockSql[1]]);
      const startedUnexpired = (await q1(`SELECT clock_timestamp() < expires_at AS u FROM subscription_purchases WHERE id = $1`, [p.purchaseId])).u;
      const cleaning = quiet(() => one(p.purchaseId, co));
      await sleep(1500);
      await blocker.query('COMMIT');
      const r = await cleaning;
      check(`R12: deadline passed while cleanup waited on the ${target} lock -> post-lock clock read -> voided`,
        startedUnexpired === true && r.outcome === 'voided', { startedUnexpired, r: r.outcome });
    }
    {
      const { co, src } = await h.makePaid('R12 control');
      const p = await upgrade(co, src, 'gold');
      await h.expireIn(p.purchaseId, 60000);
      const r = await quiet(() => one(p.purchaseId, co));
      check('R12 control: no wait, still before the deadline -> skipped_not_expired', r.outcome === 'skipped_not_expired');
      await h.expire(p.purchaseId);
      await quiet(() => one(p.purchaseId, co));
    }
    // R13 — company busy -> skipped_busy (never waits), then voided.
    {
      const co = await h.newCompany('R13');
      const p = await trialConfirm(co);
      await h.expire(p.purchaseId);
      const blocker = track(new Client(clientConfig(DB_NAME)));
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [co]);
      const t0 = Date.now();
      const busy = await quiet(() => one(p.purchaseId, co));
      const waited = Date.now() - t0;
      await blocker.query('COMMIT');
      const later = await quiet(() => one(p.purchaseId, co));
      check(`R13: company held elsewhere -> skipped_busy immediately (${waited} ms), zero writes; released -> voided`,
        busy.outcome === 'skipped_busy' && waited < 1000 && later.outcome === 'voided');
    }
    // R14 — lock_timeout on the invoice lock -> skipped_lock_timeout, then retry voids.
    {
      const co = await h.newCompany('R14');
      const p = await trialConfirm(co);
      await h.expire(p.purchaseId);
      const blocker = track(new Client(clientConfig(DB_NAME)));
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query(`SELECT i.id FROM invoices i JOIN subscription_purchases sp ON sp.invoice_id = i.id WHERE sp.id = $1 FOR UPDATE OF i`, [p.purchaseId]);
      const t0 = Date.now();
      const r = await quiet(() => one(p.purchaseId, co));
      const waited = Date.now() - t0;
      await blocker.query('COMMIT');
      const retry = await quiet(() => one(p.purchaseId, co));
      check(`R14: invoice held > lock_timeout -> skipped_lock_timeout after ~5 s (${waited} ms), rolled back; retry -> voided`,
        r.outcome === 'skipped_lock_timeout' && waited >= 4500 && waited < 8000 && retry.outcome === 'voided' && (await h.cleanupAudits(p.purchaseId)).length === 1, { r, waited });
    }
    // R6 — expiry vs a second confirm (same plan, and a target-plan switch), concurrently.
    for (const [label, plan] of [['same plan', 'silver'], ['target switch', 'gold']]) {
      let ok = true;
      for (let i = 0; i < ITERATIONS; i += 1) {
        const co = await h.newCompany(`R6 ${label} ${i}`);
        const p = await trialConfirm(co, 'silver');
        await sp.startCheckout(pool, co, p.purchaseId);
        await h.expire(p.purchaseId);
        const [rc, rn] = await Promise.all([
          quiet(() => one(p.purchaseId, co)).catch((e) => { noteIfDeadlock(e, 'R6c'); return { outcome: 'throw' }; }),
          trialConfirm(co, plan).catch((e) => { noteIfDeadlock(e, 'R6n'); return { kind: 'throw', e }; }),
        ]);
        const st = await h.statusOf(p.purchaseId);
        const openN = (await q1(`SELECT count(*)::int AS n FROM subscription_purchases WHERE company_id = $1 AND status = 'open'`, [co])).n;
        const audits = await h.cleanupAudits(p.purchaseId);
        const expectedCleanupAudits = rc.outcome === 'voided' ? 1 : 0;
        if (!(st.purchase === 'void' && st.invoice === 'void' && openN === 1 && rn.kind === 'created' && ['voided', 'skipped_busy', 'skipped_resolved'].includes(rc.outcome) && audits.length === expectedCleanupAudits)) {
          ok = false;
          console.log(`    R6 ${label}[${i}] rc=${rc.outcome} rn=${rn.kind} st=${JSON.stringify(st)} open=${openN} audits=${audits.length}`);
        }
      }
      check(`R6: ${ITERATIONS} × (cleanup ∥ second confirm, ${label}) -> old chain voided exactly once, exactly one open purchase, no error`, ok);
    }
    // R7 — admin company plan/status change (handleOpenPurchaseForAdminAction, the path of updateCompany/activateSubscription).
    {
      let ok = true;
      for (let i = 0; i < ITERATIONS; i += 1) {
        const co = await h.newCompany(`R7 ${i}`);
        const p = await trialConfirm(co);
        await h.expire(p.purchaseId);
        const adminTx = (async () => {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            await c.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [co]);
            const outcome = await sp.handleOpenPurchaseForAdminAction(c, co);
            await c.query(`UPDATE companies SET plan = 'gold', subscription_status = 'active' WHERE id = $1`, [co]);
            await c.query('COMMIT');
            return outcome.kind;
          } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            noteIfDeadlock(e, 'R7');
            return 'throw';
          } finally {
            c.release();
          }
        })();
        const [rc, ra] = await Promise.all([quiet(() => one(p.purchaseId, co)), adminTx]);
        const st = await h.statusOf(p.purchaseId);
        const voidedOnce = (rc.outcome === 'voided') !== (ra === 'voided');
        if (!(st.purchase === 'void' && voidedOnce && ['voided', 'none'].includes(ra))) {
          ok = false;
          console.log(`    R7[${i}] rc=${rc.outcome} ra=${ra} st=${JSON.stringify(st)}`);
        }
      }
      check(`R7: ${ITERATIONS} × (cleanup ∥ admin plan/status change) -> exactly one of them voids; admin completes`, ok);
    }
    // R8 — admin invoice creation on an upgrade company (lock + post-source-lock decision sequence of createSubscriptionInvoice).
    {
      let ok = true;
      for (let i = 0; i < ITERATIONS; i += 1) {
        const { co, src } = await h.makePaid(`R8 ${i}`);
        const p = await upgrade(co, src, 'gold');
        await h.expire(p.purchaseId);
        const adminTx = (async () => {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            await c.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [co]);
            const open = await sp.lockOpenPurchase(c, co);
            await c.query(`SELECT * FROM subscriptions WHERE company_id = $1 AND status = 'active' FOR UPDATE`, [co]);
            let kind = 'none';
            if (open) {
              if (await sp.purchaseUnexpiredNow(c, open.id)) kind = 'blocked';
              else { await sp.voidPurchaseChain(c, open.id, 'expired_admin_action'); kind = 'voided'; }
            }
            await c.query('COMMIT');
            return kind;
          } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            noteIfDeadlock(e, 'R8');
            return 'throw';
          } finally {
            c.release();
          }
        })();
        const [rc, ra] = await Promise.all([quiet(() => one(p.purchaseId, co)), adminTx]);
        const st = await h.statusOf(p.purchaseId);
        if (!(st.purchase === 'void' && st.source === 'active' && ((rc.outcome === 'voided') !== (ra === 'voided')))) {
          ok = false;
          console.log(`    R8[${i}] rc=${rc.outcome} ra=${ra} st=${JSON.stringify(st)}`);
        }
      }
      check(`R8: ${ITERATIONS} × (cleanup ∥ admin invoice creation sequence) -> exactly one void; source untouched`, ok);
    }
    // R9 — admin createPaymentAttempt shape (invoice lock only) vs cleanup, concurrently.
    {
      let ok = true;
      for (let i = 0; i < ITERATIONS; i += 1) {
        const co = await h.newCompany(`R9 ${i}`);
        const p = await trialConfirm(co);
        await h.expire(p.purchaseId);
        const attemptTx = (async () => {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            const inv = (await c.query(`SELECT i.id, i.status FROM invoices i JOIN subscription_purchases sp ON sp.invoice_id = i.id WHERE sp.id = $1 FOR UPDATE OF i`, [p.purchaseId])).rows[0];
            if (inv.status !== 'issued') {
              await c.query('ROLLBACK');
              return 'not_eligible';
            }
            await c.query(
              `INSERT INTO payment_attempts (invoice_id, company_id, subscription_id, amount, currency, plan, billing_interval, period_start, period_end, idempotency_key)
               SELECT id, company_id, subscription_id, amount, currency, plan, billing_interval, period_start, period_end, 'smoke-r9-' || gen_random_uuid() FROM invoices WHERE id = $1`, [inv.id]);
            await c.query('COMMIT');
            return 'created';
          } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            noteIfDeadlock(e, 'R9');
            return 'throw';
          } finally {
            c.release();
          }
        })();
        const [rc, ra] = await Promise.all([quiet(() => one(p.purchaseId, co)), attemptTx]);
        const atts = await h.attemptsOf(p.purchaseId);
        const good = rc.outcome === 'voided' &&
          ((ra === 'created' && atts.length === 1 && atts[0].status === 'cancelled') || (ra === 'not_eligible' && atts.length === 0));
        if (!good) {
          ok = false;
          console.log(`    R9[${i}] rc=${rc.outcome} ra=${ra} atts=${JSON.stringify(atts)}`);
        }
      }
      check(`R9: ${ITERATIONS} × (cleanup ∥ admin createPaymentAttempt) -> attempt cancelled by the void, or rejected on the void invoice`, ok);
    }
    // R10 — two workers on the same 10 candidates.
    {
      const items = [];
      for (let i = 0; i < 10; i += 1) {
        const co = await h.newCompany(`R10 ${i}`);
        const p = await trialConfirm(co);
        await sp.startCheckout(pool, co, p.purchaseId);
        await h.expire(p.purchaseId);
        items.push({ id: p.purchaseId, company_id: co });
      }
      const results = await quiet(() => Promise.all(items.flatMap((it) => [cleanup.cleanupOneExpiredPurchase(pool, it), cleanup.cleanupOneExpiredPurchase(pool, it)])));
      let ok = true;
      for (let i = 0; i < items.length; i += 1) {
        const pair = [results[2 * i].outcome, results[2 * i + 1].outcome];
        const audits = await h.cleanupAudits(items[i].id);
        if (!(pair.filter((o) => o === 'voided').length === 1 && audits.length === 1 && (await h.statusOf(items[i].id)).purchase === 'void')) {
          ok = false;
          console.log(`    R10 item ${i}: ${pair} audits=${audits.length}`);
        }
      }
      check('R10: two concurrent workers per purchase -> each purchase voided exactly once, exactly one audit row, no error', ok);
    }

    // ======================================================================
    console.log('\n== R11 — three real processes (replica simulation, design v3 §8.2) ==');
    {
      cleanup.resetExpiredPurchaseCleanupState();
      const ids = [];
      for (let i = 0; i < 30; i += 1) {
        const co = await h.newCompany(`R11 ${i}`);
        const p = await trialConfirm(co);
        await h.expire(p.purchaseId);
        ids.push(p.purchaseId);
      }
      const CHILD = [
        "require('ts-node/register/transpile-only');",
        "const out = process.stdout.write.bind(process.stdout); console.log = () => {}; console.error = () => {};",
        "const m = require('./src/services/expiredPurchaseCleanup'); const { pool } = require('./src/db/pool');",
        "m.sweepExpiredPurchases().then((s) => { out('RESULT ' + JSON.stringify(s) + '\\n'); return pool.end(); }).then(() => process.exit(0)).catch(() => process.exit(3));",
      ].join(' ');
      const runReplica = () => new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', CHILD], { cwd: BACKEND_DIR, env: { ...process.env, DATABASE_URL: APP_DB_URL } });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('exit', (code) => {
          const line = out.split('\n').find((l) => l.startsWith('RESULT '));
          resolve({ code, summary: line ? JSON.parse(line.slice(7)) : null });
        });
      });
      const rounds = [];
      for (let round = 0; round < 4 && (await openExpiredCount()) > 0; round += 1) rounds.push(await Promise.all([runReplica(), runReplica(), runReplica()]));
      const first = rounds[0];
      const firstVoided = first.reduce((n, r) => n + (r.summary ? r.summary.voided : 0), 0);
      const allOk = rounds.every((rs) => rs.every((r) => r.code === 0 && r.summary && r.summary.enabled && r.summary.errors === 0));
      const perPurchase = await rows(
        `SELECT sp.id, sp.status, (SELECT count(*)::int FROM audit_logs a WHERE a.entity_id = sp.id AND a.action = 'subscription_purchase_voided') AS audits
         FROM subscription_purchases sp WHERE sp.id = ANY($1::uuid[])`, [ids]);
      const totalVoided = rounds.flat().reduce((n, r) => n + (r.summary ? r.summary.voided : 0), 0);
      check(`R11: round 1 of 3 simultaneous processes voided ${firstVoided} (≤ 30; overlaps allowed as skips), every process exited cleanly`,
        allOk && firstVoided <= 30 && firstVoided >= 25, first.map((r) => r.summary));
      check(`R11: after ${rounds.length} round(s) all 30 are void, each with exactly one audit row, and the summed voided count is exactly 30 (no duplicate transition)`,
        perPurchase.length === 30 && perPurchase.every((r) => r.status === 'void' && r.audits === 1) && totalVoided === 30, { totalVoided, rounds: rounds.length });
    }

    // ======================================================================
    console.log('\n== F — failure handling (design v3 §8.4, §12.3) ==');
    {
      const co = await h.newCompany('F1');
      const p = await trialConfirm(co);
      await sp.startCheckout(pool, co, p.purchaseId);
      await h.expire(p.purchaseId);
      const conn = track(new Client(clientConfig(DB_NAME)));
      await conn.connect();
      const db = hookedConnectable(conn, { COMMIT: async () => { throw Object.assign(new Error('injected COMMIT failure'), { code: '08006' }); } });
      const r = await quiet(() => cleanup.cleanupOneExpiredPurchase(db, { id: p.purchaseId, company_id: co }));
      const st = await h.statusOf(p.purchaseId);
      const atts = await h.attemptsOf(p.purchaseId);
      check('F1: crash at COMMIT -> error/commit; nothing partial (purchase open, invoice issued, attempt initiated, session pending)',
        r.outcome === 'error' && r.errorClass === 'commit' && st.purchase === 'open' && st.invoice === 'issued' && st.pending === 'pending_payment' &&
        atts[0].status === 'initiated' && atts[0].session_status === 'pending', { r, st });
      const retry = await quiet(() => one(p.purchaseId, co));
      check('F1: retry voids exactly once (one audit row)', retry.outcome === 'voided' && (await h.cleanupAudits(p.purchaseId)).length === 1);
    }
    // X1 — cross-tenant substitution.
    {
      const coA = await h.newCompany('X1 A');
      const coB = await h.newCompany('X1 B');
      const pA = await trialConfirm(coA);
      const pB = await trialConfirm(coB);
      await h.expire(pA.purchaseId);
      await h.expire(pB.purchaseId);
      const fA = await h.fingerprint(pA.purchaseId);
      const fB = await h.fingerprint(pB.purchaseId);
      const r = await quiet(() => one(pA.purchaseId, coB));
      check('X1: purchase of tenant A presented with company B -> skipped_missing; zero writes on both tenants',
        r.outcome === 'skipped_missing' && (await h.fingerprint(pA.purchaseId)) === fA && (await h.fingerprint(pB.purchaseId)) === fB);
      await quiet(() => one(pA.purchaseId, coA));
      await quiet(() => one(pB.purchaseId, coB));
    }

    // ======================================================================
    console.log('\n== L — sweep budgets, starvation, deployed shapes (design v3 §5.1, §12.5) ==');
    check('precondition: no open expired purchase left before the budget tests', (await openExpiredCount()) === 0, await openExpiredCount());
    const fpShapes = [await h.fingerprint(pDone.purchaseId), await h.fingerprint(pSup1.purchaseId)];
    {
      cleanup.resetExpiredPurchaseCleanupState();
      const ids = [];
      for (let i = 0; i < 60; i += 1) {
        const co = await h.newCompany(`L4 ${i}`);
        const p = await trialConfirm(co);
        await h.expire(p.purchaseId);
        ids.push(p.purchaseId);
      }
      const s1 = await quiet(() => cleanup.sweepExpiredPurchases());
      const firstBatch = await rows(`SELECT id FROM subscription_purchases WHERE id = ANY($1::uuid[]) AND status = 'void' ORDER BY expires_at, id`, [ids]);
      const s2 = await quiet(() => cleanup.sweepExpiredPurchases());
      const s3 = await quiet(() => cleanup.sweepExpiredPurchases());
      check(`L4: 60 eligible -> per call ≤ 25 committed voids and ≤ 100 processed (${s1.voided}/${s1.processed}, ${s2.voided}/${s2.processed}, ${s3.voided}/${s3.processed}); three calls drain all 60`,
        s1.voided === 25 && s1.processed === 25 && s2.voided === 25 && s3.voided === 10 && (await openExpiredCount()) === 0);
      check('L4: the first call voided the 25 OLDEST candidates', JSON.stringify(firstBatch.map((r) => r.id)) === JSON.stringify(ids.slice(0, 25)));
    }
    {
      cleanup.resetExpiredPurchaseCleanupState();
      const blockers = [];
      const busyIds = [];
      const anomalyL7 = [];
      const eligible = [];
      for (let i = 0; i < 12; i += 1) {
        const co = await h.newCompany(`L7 busy ${i}`);
        const p = await trialConfirm(co);
        await h.expire(p.purchaseId);
        const b = track(new Client(clientConfig(DB_NAME)));
        await b.connect();
        await b.query('BEGIN');
        await b.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [co]);
        blockers.push(b);
        busyIds.push(p.purchaseId);
      }
      for (let i = 0; i < 13; i += 1) {
        const co = await h.newCompany(`L7 anomaly ${i}`);
        const p = await trialConfirm(co);
        await h.fixture(`UPDATE invoices SET status = 'paid', payment_date = clock_timestamp() WHERE id = (SELECT invoice_id FROM subscription_purchases WHERE id = $1)`, [p.purchaseId]);
        await h.expire(p.purchaseId);
        anomalyL7.push(p.purchaseId);
      }
      for (let i = 0; i < 10; i += 1) {
        const co = await h.newCompany(`L7 ok ${i}`);
        const p = await trialConfirm(co);
        await h.expire(p.purchaseId);
        eligible.push(p.purchaseId);
      }
      const s = await quiet(() => cleanup.sweepExpiredPurchases());
      const eligibleVoid = (await q1(`SELECT count(*)::int AS n FROM subscription_purchases WHERE id = ANY($1::uuid[]) AND status = 'void'`, [eligible])).n;
      check(`L7: 12 busy + 13 anomalous oldest do not starve 10 later eligible rows in the same call (processed ${s.processed}, voided ${s.voided}, busy ${s.skipped_busy}, anomalies ${s.anomalies})`,
        s.processed === 35 && s.voided === 10 && s.skipped_busy === 12 && s.anomalies === 13 && eligibleVoid === 10);
      for (const b of blockers) await b.query('COMMIT');
      const s2 = await quiet(() => cleanup.sweepExpiredPurchases());
      check('L7: once released, the busy rows are voided on the next tick (anomalies stay open, zero writes)',
        s2.voided === 12 && (await q1(`SELECT count(*)::int AS n FROM subscription_purchases WHERE id = ANY($1::uuid[]) AND status = 'open'`, [anomalyL7])).n === 13);
      for (const id of anomalyL7) await h.neutralize(id);
    }
    {
      // L7 rotation with small budgets: 30 busy head rows, 10 later eligible.
      cleanup.resetExpiredPurchaseCleanupState();
      const blockers = [];
      const eligible = [];
      for (let i = 0; i < 30; i += 1) {
        const co = await h.newCompany(`rot busy ${i}`);
        const p = await trialConfirm(co);
        await h.expire(p.purchaseId);
        const b = track(new Client(clientConfig(DB_NAME)));
        await b.connect();
        await b.query('BEGIN');
        await b.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [co]);
        blockers.push(b);
      }
      for (let i = 0; i < 10; i += 1) {
        const co = await h.newCompany(`rot ok ${i}`);
        const p = await trialConfirm(co);
        await h.expire(p.purchaseId);
        eligible.push(p.purchaseId);
      }
      const r1 = await quiet(() => cleanup.sweepExpiredPurchases({ scanBudget: 20, pageSize: 10 }));
      const r2 = await quiet(() => cleanup.sweepExpiredPurchases({ scanBudget: 20, pageSize: 10 }));
      const eligibleVoid = (await q1(`SELECT count(*)::int AS n FROM subscription_purchases WHERE id = ANY($1::uuid[]) AND status = 'void'`, [eligible])).n;
      check(`L7 rotation: scanBudget 20 / pageSize 10, 30 busy head rows -> each call processes exactly 20 (${r1.processed}, ${r2.processed}); the 10 later rows are voided by call 2`,
        r1.processed === 20 && r1.voided === 0 && r2.processed === 20 && r2.voided === 10 && eligibleVoid === 10);
      for (const b of blockers) await b.query('COMMIT');
      await quiet(() => cleanup.sweepExpiredPurchases());
      await quiet(() => cleanup.sweepExpiredPurchases());
    }
    check('L6: deployed shapes (completed + lazily voided) byte-identical after every sweep',
      (await h.fingerprint(pDone.purchaseId)) === fpShapes[0] && (await h.fingerprint(pSup1.purchaseId)) === fpShapes[1]);
    {
      // Kill switch inside a real process: flags off -> no DB access.
      const { env } = require('../src/config/env');
      const co = await h.newCompany('Switch');
      const p = await trialConfirm(co);
      await h.expire(p.purchaseId);
      env.ENABLE_EXPIRED_PURCHASE_CLEANUP = false;
      const off1 = await cleanup.sweepExpiredPurchases();
      env.ENABLE_EXPIRED_PURCHASE_CLEANUP = true;
      env.ENABLE_BACKGROUND_SWEEPS = false;
      const off2 = await cleanup.sweepExpiredPurchases();
      env.ENABLE_BACKGROUND_SWEEPS = true;
      check('kill switch: either flag off -> sweep is a no-op (purchase stays open)',
        !off1.enabled && !off2.enabled && off1.processed === 0 && off2.processed === 0 && (await h.statusOf(p.purchaseId)).purchase === 'open');
      await quiet(() => cleanup.sweepExpiredPurchases());
    }
    // F2 in the real database: an anomalous row in the middle of a batch.
    {
      cleanup.resetExpiredPurchaseCleanupState();
      const mk3 = [];
      for (let i = 0; i < 3; i += 1) {
        const co = await h.newCompany(`F2 ${i}`);
        const p = await trialConfirm(co);
        if (i === 1) await h.fixture(`UPDATE subscriptions SET status = 'abandoned' WHERE id = (SELECT subscription_id FROM subscription_purchases WHERE id = $1)`, [p.purchaseId]);
        await h.expire(p.purchaseId);
        mk3.push(p.purchaseId);
      }
      const fpMid = await h.fingerprint(mk3[1]);
      const s = await quiet(() => cleanup.sweepExpiredPurchases());
      check('F2: one failing (anomalous) item in a batch -> the other two voided, the failing one rolled back with zero writes',
        s.voided === 2 && s.anomalies === 1 && (await h.fingerprint(mk3[1])) === fpMid);
      await h.neutralize(mk3[1]);
    }

    // ======================================================================
    console.log('\n== X3 — provider tripwire on the _prov database (provider CHECK dropped there only) ==');
    {
      const provPool = new Pool({ connectionString: dbUrl(DB_PROV) });
      extraPools.push(provPool);
      const provSetup = track(new Client(clientConfig(DB_PROV)));
      await provSetup.connect();
      const hp = mk(provSetup);
      const conname = (await provSetup.query(
        `SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'payment_checkout_sessions' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%provider%'`
      )).rows[0].conname;
      await provSetup.query(`ALTER TABLE payment_checkout_sessions DROP CONSTRAINT ${conname}`);
      const pre = runPreflight(DB_PROV, ['--checks-only']);
      check('P3 (semantic): with the provider CHECK dropped, PREFLIGHT_B8_2 STOPs (exit 2)', pre.code === 2 && pre.out.includes('P3:'), pre.out.slice(-600));
      const cases = [['terminal attempt (failed/failed)', 'failed'], ['initiated attempt (pending)', null]];
      for (const [label, outcome] of cases) {
        const co = await hp.newCompany(`prov ${label}`);
        const p = await trialConfirm(co, 'silver', 'monthly', provPool);
        const c = await sp.startCheckout(provPool, co, p.purchaseId);
        if (outcome) await resolveCheckoutSessionCore(provPool, c.sessionId, outcome);
        await hp.fixture(`UPDATE payment_checkout_sessions SET provider = 'myfatoorah' WHERE id = $1`, [c.sessionId]);
        await hp.expire(p.purchaseId);
        const fp = await hp.fingerprint(p.purchaseId);
        const r = await quiet(() => one(p.purchaseId, co, provPool));
        check(`X3: non-simulated session on a ${label} -> provider_guard, zero writes`, r.outcome === 'provider_guard' && (await hp.fingerprint(p.purchaseId)) === fp, r);
        let err = null;
        try {
          await trialConfirm(co, 'gold', 'monthly', provPool);
        } catch (e) {
          err = e;
        }
        check(`X3: the lazy confirm path over the same chain -> PurchaseChainAnomaly(provider_guard), full rollback`,
          err instanceof sp.PurchaseChainAnomaly && err.anomalyClass === 'provider_guard' && (await hp.fingerprint(p.purchaseId)) === fp);
      }
    }

    // ======================================================================
    console.log('\n== L9 — PREFLIGHT_B8_2 snapshot / post-deploy modes on the _pre database ==');
    {
      const prePool = new Pool({ connectionString: dbUrl(DB_PRE) });
      extraPools.push(prePool);
      const preSetup = track(new Client(clientConfig(DB_PRE)));
      await preSetup.connect();
      const hq = mk(preSetup);
      const pre = require('./PREFLIGHT_B8_2_expired_purchase_cleanup_check');
      const tmp = (name) => {
        const f = path.join(os.tmpdir(), `b8_2_${RUN_ID}_${name}.jsonl`);
        tmpFiles.push(f);
        return f;
      };
      // Fixtures: one expired trial, one expired upgrade, one unexpired trial.
      const coT2 = await hq.newCompany('Secret Company Name Trial');
      await hq.addUser(coT2, 'secret.admin@example.test');
      const pT2 = await trialConfirm(coT2, 'silver', 'monthly', prePool);
      const { co: coU2, src: srcU2 } = await hq.makePaid('Secret Company Name Upgrade');
      const pU2 = await upgrade(coU2, srcU2, 'gold', 'monthly', prePool);
      await sp.startCheckout(prePool, coU2, pU2.purchaseId);
      const coN = await hq.newCompany('Unexpired');
      await trialConfirm(coN, 'silver', 'monthly', prePool);
      await hq.expire(pT2.purchaseId);
      await hq.expire(pU2.purchaseId);

      const insideRepo = path.join(__dirname, `b8_2_snapshot_${RUN_ID}.jsonl`);
      const refuse = runPreflight(DB_PRE, ['--snapshot-out', insideRepo]);
      check('L9(b): a snapshot path inside the repository is refused (exit 1, no file)', refuse.code === 1 && !fs.existsSync(insideRepo), refuse.out.slice(-300));

      const snapA = tmp('a');
      const snapB = tmp('b');
      const runA = runPreflight(DB_PRE, ['--snapshot-out', snapA]);
      const runB = runPreflight(DB_PRE, ['--snapshot-out', snapB], { PGOPTIONS: '-c TimeZone=America/New_York' });
      const again = runPreflight(DB_PRE, ['--snapshot-out', snapA]);
      check('L9(a): pre-enable mode passes and writes the snapshot file (exit 0); an existing file is never overwritten', runA.code === 0 && fs.existsSync(snapA) && again.code === 1, runA.out.slice(-600));
      const textA = fs.readFileSync(snapA, 'utf8');
      const parsedA = pre.parseSnapshot(textA);
      const tRow = parsedA.rows.find((r) => r.purchase_id === pT2.purchaseId);
      const uRow = parsedA.rows.find((r) => r.purchase_id === pU2.purchaseId);
      check('L9(a): header v1 + exactly the 2 expired open purchases, with the exact approved fields per kind',
        parsedA.header.snapshot_version === 1 && parsedA.rows.length === 2 && tRow && uRow &&
        Object.keys(tRow).join(',') === 'type,kind,purchase_id,company_id,company_plan,company_subscription_status,trial_start_date,trial_end_date,company_billing_event_count' &&
        Object.keys(uRow).join(',') === 'type,kind,purchase_id,company_id,source_subscription_id,source_fp,company_plan,company_subscription_status,company_billing_event_count' &&
        uRow.source_subscription_id === srcU2 && tRow.company_plan === 'trial' && tRow.company_subscription_status === 'trial' && /^\d{4}-\d{2}-\d{2}T/.test(tRow.trial_end_date));
      check('L9(a): redaction — no company name, user email, token or secret in the snapshot file or the script output',
        !/Secret Company|secret\.admin|@example|jwt|token|password/i.test(textA) && !/Secret Company|secret\.admin@/i.test(runA.out));
      const rowsB = pre.parseSnapshot(fs.readFileSync(snapB, 'utf8')).rows;
      check('L9(f): identical row values under a non-UTC session TimeZone (America/New_York)', JSON.stringify(rowsB) === JSON.stringify(parsedA.rows));

      // Enable: sweep on the _pre database.
      cleanup.resetExpiredPurchaseCleanupState();
      const sPre = await quiet(() => cleanup.sweepExpiredPurchases({ db: prePool }));
      // The service's post-commit audit always writes through the application's
      // single pool (the <main> database here), so on this separate database
      // the rows have NO audit row and must classify as CLEANED_NO_AUDIT (Q6).
      const post0 = runPreflight(DB_PRE, ['--post-deploy', snapA]);
      check('L9(c): after the sweep, post-deploy passes; void rows without an audit row are CLEANED_NO_AUDIT / MATCH and counted by Q6',
        sPre.voided === 2 && sPre.audit_errors === 2 && post0.code === 0 && post0.out.includes('"CLEANED_NO_AUDIT":2') &&
        post0.out.includes('snapshot rows CLEANED_NO_AUDIT=2'), post0.out.slice(-900));
      for (const pid of [pT2.purchaseId, pU2.purchaseId]) {
        await preSetup.query(
          `INSERT INTO audit_logs (company_id, action, entity_type, entity_id, old_values, new_values)
           SELECT company_id, 'subscription_purchase_voided', 'subscription_purchases', id, '{"status":"open"}', '{"status":"void","reason":"expired_cleanup"}'
           FROM subscription_purchases WHERE id = $1`, [pid]);
      }
      const post1 = runPreflight(DB_PRE, ['--post-deploy', snapA]);
      check('L9(c): with the expired_cleanup audit rows present, both snapshot rows are CLEANED / MATCH (exit 0)',
        post1.code === 0 && (post1.out.match(/'MATCH'/g) || []).length === 2 && post1.out.includes('"CLEANED":2'), post1.out.slice(-900));

      // Post-snapshot purchase: invariants only, never compared.
      const coLate = await hq.newCompany('Late');
      const pLate = await trialConfirm(coLate, 'silver', 'monthly', prePool);
      await hq.expire(pLate.purchaseId);
      await quiet(() => cleanup.sweepExpiredPurchases({ db: prePool }));
      const post2 = runPreflight(DB_PRE, ['--post-deploy', snapA]);
      check('L9(e): a purchase that expired after the snapshot is checked under Q8 only (not compared) and passes',
        post2.code === 0 && post2.out.includes('Q8: post-snapshot voids (no before/after comparison possible)=1') && !post2.out.includes(pLate.purchaseId), post2.out.slice(-900));

      // Unexplained change (no audited event) -> STOP; explained (audited event) -> review, not STOP.
      await preSetup.query(`UPDATE companies SET trial_end_date = trial_end_date + interval '1 day' WHERE id = $1`, [coT2]);
      const post3 = runPreflight(DB_PRE, ['--post-deploy', snapA]);
      check('L9(d): an unaudited change to a trial date -> MISMATCH_UNEXPLAINED and STOP (exit 2)', post3.code === 2 && post3.out.includes('MISMATCH_UNEXPLAINED'), post3.out.slice(-900));
      await preSetup.query(`INSERT INTO audit_logs (company_id, action, entity_type, entity_id) VALUES ($1, 'admin_company_billing_updated', 'companies', $1)`, [coT2]);
      const post4 = runPreflight(DB_PRE, ['--post-deploy', snapA]);
      check('L9(d): the same change with a later audited billing event -> MISMATCH_EXPLAINED (listed for review, exit 0)', post4.code === 0 && post4.out.includes('MISMATCH_EXPLAINED'), post4.out.slice(-900));
      await preSetup.query(`UPDATE companies SET plan = 'silver' WHERE id = $1`, [coU2]);
      const post5 = runPreflight(DB_PRE, ['--post-deploy', snapA]);
      check('L9(d): an unaudited upgrade-company plan change -> STOP (Q3)', post5.code === 2 && post5.out.includes('Q3:'), post5.out.slice(-600));
      await preSetup.query(`UPDATE companies SET plan = 'bronze' WHERE id = $1`, [coU2]);

      // Malformed / stale snapshots.
      const bad = (name, text) => { const f = tmp(name); fs.writeFileSync(f, text); return runPreflight(DB_PRE, ['--post-deploy', f]); };
      const lines = textA.trim().split('\n');
      const hdr = JSON.parse(lines[0]);
      const r0 = JSON.parse(lines[1]);
      const results = {
        notJson: bad('notjson', '{oops\n'),
        version: bad('version', [JSON.stringify({ ...hdr, snapshot_version: 2 }), ...lines.slice(1)].join('\n')),
        extraField: bad('extra', [lines[0], JSON.stringify({ ...r0, company_name: 'x' }), ...lines.slice(2)].join('\n')),
        rowCount: bad('rowcount', [JSON.stringify({ ...hdr, row_count: 5 }), ...lines.slice(1)].join('\n')),
        unknownPurchase: bad('unknown', [JSON.stringify({ ...hdr, row_count: 1 }), JSON.stringify({ ...r0, purchase_id: crypto.randomUUID() })].join('\n')),
      };
      check('L9(g): malformed snapshots (bad JSON, unknown version, extra field, wrong row_count) and a stale/foreign one (unknown purchase id) -> STOP (exit 2)',
        Object.values(results).every((r) => r.code === 2), Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.code])));

      // P5: an anomalous expired purchase blocks the pre-enable run and no file is written.
      const coBad = await hq.newCompany('Bad');
      const pBad = await trialConfirm(coBad, 'silver', 'monthly', prePool);
      await hq.fixture(`UPDATE invoices SET status = 'paid', payment_date = clock_timestamp() WHERE id = (SELECT invoice_id FROM subscription_purchases WHERE id = $1)`, [pBad.purchaseId]);
      await hq.expire(pBad.purchaseId);
      const snapC = tmp('c');
      const runC = runPreflight(DB_PRE, ['--snapshot-out', snapC]);
      check('L9(k): an anomalous expired purchase -> STOP (P5/P6), and no snapshot file is written', runC.code === 2 && !fs.existsSync(snapC) && runC.out.includes('P5:'), runC.out.slice(-600));
      check('P3 (semantic) passes on an intact 087 database', runA.out.includes('"simulated":{"expected":true,"got":true}'));
      // Pure helpers.
      check('helpers: classifyComparison and isInsideRepo behave as designed',
        pre.classifyComparison({ kind: 'trial', company_plan: 'trial', company_subscription_status: 'trial', trial_start_date: 'a', trial_end_date: 'b', company_billing_event_count: '0' },
          { company_plan: 'trial', company_subscription_status: 'trial', trial_start_date: 'a', trial_end_date: 'b', company_billing_event_count: '0' }).result === 'MATCH' &&
        pre.isInsideRepo(path.join(__dirname, 'x.jsonl')) && !pre.isInsideRepo(path.join(os.tmpdir(), 'x.jsonl')));
    }

    // ======================================================================
    console.log('\n== Totals ==');
    const violations = (await rows(
      `SELECT sp.id FROM subscription_purchases sp WHERE sp.status = 'void' AND (
         NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = sp.invoice_id AND i.status = 'void' AND i.payment_date IS NULL)
         OR NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = sp.subscription_id AND s.status = 'abandoned')
         OR EXISTS (SELECT 1 FROM payment_attempts a WHERE a.invoice_id = sp.invoice_id AND a.status IN ('initiated','succeeded'))
         OR EXISTS (SELECT 1 FROM payment_attempts a JOIN payment_checkout_sessions ps ON ps.payment_attempt_id = a.id WHERE a.invoice_id = sp.invoice_id
                    AND NOT ((a.status = 'failed' AND ps.status = 'failed') OR (a.status = 'cancelled' AND ps.status = 'cancelled'))))`)).length;
    check(`C9: terminal-consistency invariant holds for every void purchase (${(await q1(`SELECT count(*)::int AS n FROM subscription_purchases WHERE status = 'void'`)).n} void purchases)`, violations === 0, violations);
    check('C10: no confirmation job exists for any non-completed purchase', (await confirmationJobsForNonCompleted()) === 0);
    check('no paid invoice was ever voided', (await q1(`SELECT count(*)::int AS n FROM invoices WHERE status = 'void' AND payment_date IS NOT NULL`)).n === 0);
    const endDeadlocks = Number((await q1(`SELECT deadlocks FROM pg_stat_database WHERE datname = $1`, [DB_NAME])).deadlocks);
    check(`zero 40P01 deadlocks observed by the app (${deadlocks.length}) and by pg_stat_database (${endDeadlocks - startDeadlocks})`,
      deadlocks.length === 0 && endDeadlocks - startDeadlocks === 0, deadlocks);

    const failed = checks.filter(([, pass]) => !pass);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
    exitCode = failed.length === 0 ? 0 : 1;
  } catch (err) {
    console.error('SMOKE RUN ERROR:', err);
    exitCode = 1;
  } finally {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* absent */ }
    }
    if (appPool) await appPool.end().catch(() => {});
    for (const p of extraPools) await p.end().catch(() => {});
    for (const c of openClients) await c.end().catch(() => {});
    const cleanupClient = new Client(clientConfig(parsedConfig.database));
    try {
      await cleanupClient.connect();
      for (const db of created) {
        await cleanupClient.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [db]);
        await cleanupClient.query(`DROP DATABASE IF EXISTS ${db}`);
        console.log(`Dropped disposable database ${db}.`);
      }
    } catch (e) {
      console.error(`CLEANUP FAILED: could not confirm the disposable databases were dropped (${e.message}). Check: ${created.join(', ')}`);
      exitCode = 1;
    } finally {
      await cleanupClient.end().catch(() => {});
    }
  }
  process.exit(exitCode);
}

main();
