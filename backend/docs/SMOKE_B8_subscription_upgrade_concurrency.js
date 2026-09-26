/**
 * Standalone disposable-PostgreSQL proof for Stage B8 (Paid-to-Paid
 * Self-Service Subscription Upgrades — design pass v4, approved; see
 * claude/chat8a-b8-paid-subscription-upgrade-design-pass-v4-2026-09-24.md
 * §15.4). Same safety conventions as SMOKE_B1/B3/B5/B6/B7: explicit host
 * validation (localhost / 127.0.0.1 only, no default substitution),
 * SMOKE_CONFIRM_DISPOSABLE=yes required, uniquely-named throwaway databases,
 * every client closed before DROP DATABASE, a cleanup failure fails the run,
 * and zero 40P01 deadlocks asserted.
 *
 * The main database is built by replaying the REAL repository schema history
 * (root docs/DATABASE_SCHEMA.sql, then every MIGRATION_0NN file through 085,
 * then the REAL 086, then the REAL 087). A second disposable database is
 * built through 086 only, for the preflight fixtures (T-PRE-*) and the
 * "B7 purchase created before 087" regression (T-REG-2).
 *
 * The application side is the REAL TypeScript code loaded through ts-node
 * (services/subscriptionPurchase.ts, services/paymentSettlement.ts,
 * controllers/admin.controller.ts, controllers/billing.controller.ts,
 * middleware/requirePlan's planLevelOf). T-COMPAT-4 additionally loads the
 * ACCEPTED B7 code (commit aadd332) extracted READ-ONLY with `git archive`
 * into a temporary directory outside the repository — no worktree, no
 * checkout, no change to the repository.
 *
 * Run with (bash):
 *   SMOKE_CONCURRENCY_ADMIN_URL="postgres://pguser@127.0.0.1:55432/postgres" \
 *   SMOKE_CONFIRM_DISPOSABLE=yes \
 *     node docs/SMOKE_B8_subscription_upgrade_concurrency.js
 *
 * Review fix B8-R1 adds T-DL-3 / T-DL-4: the SOURCE subscription row is held
 * past the purchase deadline, and only the post-source-lock clock read may
 * decide replay/void (confirm) or block/void (createSubscriptionInvoice).
 *
 * Optional: SMOKE_B8_ITERATIONS (default 6), SMOKE_B8_LEGACY_REF (default
 * aadd33274e4606a3234a10cfe50fffd04e0840f2), SMOKE_B8_SKIP_LEGACY=yes to skip
 * T-COMPAT-4 where git history is unavailable (reported, not silently passed).
 *
 * Point ADMIN_URL at a local/dev Postgres server you control, never at
 * production. The role needs CREATEDB and superuser (T-DB-1 uses
 * session_replication_role to prove an index independently of a trigger).
 */

const { Client, Pool } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const RAW_ADMIN_URL = process.env.SMOKE_CONCURRENCY_ADMIN_URL;
const CONFIRM_DISPOSABLE = process.env.SMOKE_CONFIRM_DISPOSABLE;
const ITERATIONS = Number.parseInt(process.env.SMOKE_B8_ITERATIONS || '6', 10);
const LEGACY_REF = process.env.SMOKE_B8_LEGACY_REF || 'aadd33274e4606a3234a10cfe50fffd04e0840f2';
const SKIP_LEGACY = process.env.SMOKE_B8_SKIP_LEGACY === 'yes';

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
const DB_NAME = `smoke_b8_upgrade_${RUN_ID}`;
const DB_086 = `smoke_b8_pre087_${RUN_ID}`;
const port = parsedConfig.port || 5432;
const userPart = parsedConfig.user ? `${encodeURIComponent(parsedConfig.user)}${parsedConfig.password ? `:${encodeURIComponent(parsedConfig.password)}` : ''}@` : '';
const urlFor = (db) => `postgres://${userPart}${rawHost}:${port}/${db}?options=${encodeURIComponent('-c lock_timeout=8000 -c statement_timeout=20000')}`;
const APP_DB_URL = urlFor(DB_NAME);
console.log(`Target (redacted): postgres://${parsedConfig.user || '(default)'}:***@${rawHost}:${port}/${DB_NAME}`);

process.env.DATABASE_URL = APP_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-only-jwt-secret-not-real';
process.env.ENABLE_BACKGROUND_SWEEPS = 'false';
process.env.RESEND_API_KEY = '';

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

async function buildSchema(setup, upto) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  await setup.query(fs.readFileSync(path.join(repoRoot, 'docs', 'DATABASE_SCHEMA.sql'), 'utf8'));
  const migrations = fs.readdirSync(__dirname).filter((f) => /^MIGRATION_0\d\d_.*\.sql$/.test(f)).sort();
  for (const file of migrations) {
    if (file >= 'MIGRATION_086') continue;
    await setup.query(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  }
  await setup.query(fs.readFileSync(path.join(__dirname, 'MIGRATION_086_subscription_purchase_foundation.sql'), 'utf8'));
  if (upto === '087') {
    await setup.query(fs.readFileSync(path.join(__dirname, 'MIGRATION_087_subscription_upgrade_foundation.sql'), 'utf8'));
  }
  console.log(`Built the schema through MIGRATION_${upto} (real files).`);
}

function recordingConnectable(client, record) {
  const query = async (sql, params) => {
    const res = await client.query(sql, params);
    if (sql === 'BEGIN') {
      record.txnNow = (await client.query('SELECT now() AS t, clock_timestamp() AS c')).rows[0];
    }
    return res;
  };
  return { query, connect: async () => ({ query, release: () => {} }) };
}

function makeReq(params, body, auth) {
  return { params, body, headers: { 'user-agent': 'smoke-b8' }, ip: '127.0.0.1', auth };
}
function invoke(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    Promise.resolve(
      handler(req, res, (err) => {
        noteIfDeadlock(err, 'controller');
        resolve({ status: err && err.statusCode ? err.statusCode : 500, error: err, body: err ? { code: err.code } : undefined });
      })
    ).catch((err) => resolve({ status: 500, error: err }));
  });
}

async function main() {
  const admin = new Client(clientConfig(parsedConfig.database));
  await admin.connect();
  const created = [];
  try {
    console.log(`PostgreSQL server: ${(await admin.query('SELECT version()')).rows[0].version}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    created.push(DB_NAME);
    await admin.query(`CREATE DATABASE ${DB_086}`);
    created.push(DB_086);
  } finally {
    await admin.end();
  }

  const openClients = [];
  const track = (c) => { openClients.push(c); return c; };
  const extraPools = [];
  let appPool = null;
  let legacyDir = null;
  let exitCode = 1;

  try {
    const setup = track(new Client(clientConfig(DB_NAME)));
    await setup.connect();
    await buildSchema(setup, '087');
    await setup.query(`SET TIME ZONE 'Asia/Kuwait'`);
    const setup086 = track(new Client(clientConfig(DB_086)));
    await setup086.connect();
    await buildSchema(setup086, '086');

    require('ts-node/register/transpile-only');
    const sp = require('../src/services/subscriptionPurchase');
    const { resolveCheckoutSessionCore } = require('../src/services/paymentSettlement');
    const { catalogPriceText } = require('../src/config/planCatalog');
    const { planLevelOf } = require('../src/config/planFeatures');
    const adminController = require('../src/controllers/admin.controller');
    const billingController = require('../src/controllers/billing.controller');
    const { pool } = require('../src/db/pool');
    appPool = pool;

    const q1 = async (sql, params) => (await setup.query(sql, params)).rows[0];
    async function expectFail(sql, params, fragment, client = setup) {
      try {
        await client.query(sql, params);
        return false;
      } catch (err) {
        return !fragment || String(err.message).includes(fragment) || String(err.code).includes(fragment) || String(err.constraint).includes(fragment);
      }
    }
    async function newCompany(label, overrides = {}, client = setup) {
      return (await client.query(
        `INSERT INTO companies (name, plan, subscription_status) VALUES ($1, $2, $3) RETURNING id`,
        [label, overrides.plan || 'trial', overrides.subscription_status || 'trial']
      )).rows[0].id;
    }
    // A paid tenant with one active live subscription on plan/interval.
    async function makePaid(label, plan, interval, client = setup) {
      const co = await newCompany(label, { plan, subscription_status: 'active' }, client);
      const sub = (await client.query(
        `WITH c AS (SELECT clock_timestamp() AS t)
         INSERT INTO subscriptions (company_id, plan, status, currency, period_amount, monthly_price, billing_interval,
                                    current_period_start, current_period_end, auto_renew, next_billing_date)
         SELECT $1, $2, 'active', 'USD', $3::numeric,
                CASE WHEN $4 = 'annual' THEN round($3::numeric / 12, 3) ELSE $3::numeric END, $4, c.t,
                ((c.t AT TIME ZONE 'UTC') + CASE WHEN $4 = 'annual' THEN interval '12 months' ELSE interval '1 month' END) AT TIME ZONE 'UTC',
                false, ((c.t AT TIME ZONE 'UTC') + CASE WHEN $4 = 'annual' THEN interval '12 months' ELSE interval '1 month' END)
         FROM c RETURNING id`,
        [co, plan, catalogPriceText(plan, interval), interval]
      )).rows[0];
      return { co, src: sub.id };
    }
    const upgrade = (co, plan, interval, expected, db = pool) =>
      sp.confirmPurchase(db, {
        companyId: co, plan, interval, currency: 'USD', amountText: catalogPriceText(plan, interval),
        ...(expected === null ? {} : { expectedSourceSubscriptionId: expected }),
      });
    const trialConfirm = (co, plan = 'silver', interval = 'monthly', db = pool) =>
      sp.confirmPurchase(db, { companyId: co, plan, interval, currency: 'USD', amountText: catalogPriceText(plan, interval) });
    async function state(co) {
      const q = async (sql) => (await setup.query(sql, [co])).rows;
      return {
        company: (await q(`SELECT plan, subscription_status FROM companies WHERE id = $1`))[0],
        subs: await q(`SELECT id, status, plan, billing_interval, period_amount::text AS amount FROM subscriptions WHERE company_id = $1 ORDER BY created_at`),
        invoices: await q(`SELECT id, status, subscription_id, amount::text AS amount, payment_date FROM invoices WHERE company_id = $1`),
        purchases: await q(`SELECT id, status, subscription_id, replaces_subscription_id FROM subscription_purchases WHERE company_id = $1`),
        attempts: await q(`SELECT id, status FROM payment_attempts WHERE company_id = $1`),
        sessions: await q(`SELECT pcs.id, pcs.status FROM payment_checkout_sessions pcs JOIN payment_attempts pa ON pa.id = pcs.payment_attempt_id WHERE pa.company_id = $1`),
      };
    }
    const count = (rows, pred) => rows.filter(pred).length;
    const live = (s) => s.subs.filter((x) => x.status === 'active' || x.status === 'past_due');
    async function writeCounts() {
      return q1(`SELECT (SELECT count(*) FROM subscriptions)::int AS s, (SELECT count(*) FROM invoices)::int AS i,
                        (SELECT count(*) FROM subscription_purchases)::int AS p, (SELECT count(*) FROM payment_attempts)::int AS a,
                        (SELECT string_agg(id::text || plan || subscription_status, ',' ORDER BY id) FROM companies) AS c,
                        (SELECT string_agg(id::text || status, ',' ORDER BY id) FROM subscriptions) AS st`);
    }
    // Short-window UPGRADE fixture (same shapes the real confirm writes).
    async function shortWindowUpgrade(co, src, windowMs, plan, interval) {
      await setup.query('BEGIN');
      const sub = (await setup.query(
        `WITH c AS (SELECT clock_timestamp() AS t)
         INSERT INTO subscriptions (company_id, plan, status, currency, period_amount, monthly_price, billing_interval,
                                    current_period_start, current_period_end, auto_renew, next_billing_date)
         SELECT $1, $2, 'pending_payment', 'USD', $3::numeric, $3::numeric, $4, c.t,
                ((c.t AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC', false,
                ((c.t AT TIME ZONE 'UTC') + interval '1 month') FROM c RETURNING id`,
        [co, plan, catalogPriceText(plan, interval), interval]
      )).rows[0];
      const inv = (await setup.query(
        `INSERT INTO invoices (company_id, subscription_id, plan, billing_interval, currency, amount, period_start, period_end, status, issue_date, due_date)
         SELECT company_id, id, plan, billing_interval, currency, period_amount, current_period_start, current_period_end, 'issued', current_period_start, current_period_start
         FROM subscriptions WHERE id = $1 RETURNING id`,
        [sub.id]
      )).rows[0];
      const pur = (await setup.query(
        `INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, replaces_subscription_id, created_at, expires_at)
         SELECT company_id, id, $2, $4, current_period_start, clock_timestamp() + make_interval(secs => $3::double precision / 1000)
         FROM subscriptions WHERE id = $1 RETURNING id, expires_at`,
        [sub.id, inv.id, windowMs, src]
      )).rows[0];
      await setup.query('COMMIT');
      return { purchaseId: pur.id, expiresAt: new Date(pur.expires_at), subId: sub.id, invoiceId: inv.id };
    }
    async function fullUpgrade(co, src, plan, interval) {
      const p = await upgrade(co, plan, interval, src);
      const c = await sp.startCheckout(pool, co, p.purchaseId);
      const r = await resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded');
      return { p, c, r };
    }

    // ======================================================================
    console.log('\n== A. T-DB-1 — MIGRATION_087 schema proofs ==');
    const coA = await newCompany('schema', { plan: 'bronze', subscription_status: 'active' });
    const subCols = `company_id, plan, currency, billing_interval, current_period_start, current_period_end, period_amount`;
    const subVals = `$1, 'bronze', 'USD', 'monthly', now(), now() + interval '1 month', 32`;
    check("INSERT as 'superseded' fails", await expectFail(`INSERT INTO subscriptions (status, ${subCols}) VALUES ('superseded', ${subVals})`, [coA], 'cannot be created as superseded'));
    const protectedCols = {
      id: 'gen_random_uuid()', company_id: `(SELECT id FROM companies WHERE id <> '${coA}' LIMIT 1)`, plan: `'gold'`,
      monthly_price: '1', auto_renew: 'NOT COALESCE(auto_renew, false)', next_billing_date: `now()::timestamp`,
      created_at: `now()::timestamp - interval '1 day'`, updated_at: `now()::timestamp - interval '1 day'`, currency: `'KWD'`,
      billing_interval: `'annual'`, current_period_start: `now() - interval '1 day'`, current_period_end: `now() + interval '2 months'`,
      period_amount: '33',
    };
    const newActive = async () => (await q1(`INSERT INTO subscriptions (status, ${subCols}) VALUES ('cancelled', ${subVals}) RETURNING id`, [coA])).id;
    // An 'active' row per case (cancelled -> active is not guarded, so this
    // builds an active row without touching the one-live index).
    let blocked = 0;
    for (const [col, expr] of Object.entries(protectedCols)) {
      const id = await newActive();
      await setup.query(`UPDATE subscriptions SET status = 'active' WHERE id = $1`, [id]);
      if (await expectFail(`UPDATE subscriptions SET status = 'superseded', ${col} = ${expr} WHERE id = $1`, [id], 'status only')) blocked += 1;
      else console.log(`    active -> superseded with ${col} changed was allowed!`);
      await setup.query(`UPDATE subscriptions SET status = 'cancelled' WHERE id = $1`, [id]);
    }
    check(`active -> superseded changing any of the 13 other columns fails (${blocked}/13)`, blocked === 13 && Object.keys(protectedCols).length === 13);
    const supId = await newActive();
    await setup.query(`UPDATE subscriptions SET status = 'active' WHERE id = $1`, [supId]);
    await setup.query(`UPDATE subscriptions SET status = 'superseded' WHERE id = $1`, [supId]);
    check('active -> superseded (status only) succeeds', (await q1(`SELECT status FROM subscriptions WHERE id = $1`, [supId])).status === 'superseded');
    check('superseded -> active fails (terminal)', await expectFail(`UPDATE subscriptions SET status = 'active' WHERE id = $1`, [supId], 'terminal and immutable'));
    let supEdits = 0;
    for (const [col, expr] of Object.entries(protectedCols)) {
      if (await expectFail(`UPDATE subscriptions SET ${col} = ${expr} WHERE id = $1`, [supId], 'terminal and immutable')) supEdits += 1;
    }
    check('every column of a superseded row is immutable (13/13)', supEdits === 13);
    const pendId = (await q1(`INSERT INTO subscriptions (status, ${subCols}) VALUES ('pending_payment', ${subVals}) RETURNING id`, [coA])).id;
    check('pending_payment -> superseded fails', await expectFail(`UPDATE subscriptions SET status = 'superseded' WHERE id = $1`, [pendId], 'only active may become superseded'));
    const cancId = await newActive();
    check('cancelled -> superseded fails', await expectFail(`UPDATE subscriptions SET status = 'superseded' WHERE id = $1`, [cancId], 'only active may become superseded'));
    await setup.query(`UPDATE subscriptions SET status = 'abandoned' WHERE id = $1`, [pendId]);
    check('abandoned -> superseded fails', await expectFail(`UPDATE subscriptions SET status = 'superseded' WHERE id = $1`, [pendId]));
    check('086 rule preserved: INSERT as abandoned still fails', await expectFail(`INSERT INTO subscriptions (status, ${subCols}) VALUES ('abandoned', ${subVals})`, [coA], 'cannot be created as abandoned'));
    check('086 rule preserved: abandoned -> active still fails', await expectFail(`UPDATE subscriptions SET status = 'active' WHERE id = $1`, [pendId], 'terminal'));

    // replaces_subscription_id constraints.
    const paidX = await makePaid('replaces X', 'bronze', 'monthly');
    const paidY = await makePaid('replaces Y', 'bronze', 'monthly');
    const pX = await upgrade(paidX.co, 'gold', 'monthly', paidX.src);
    const rowX = await q1(`SELECT * FROM subscription_purchases WHERE id = $1`, [pX.purchaseId]);
    check('the real confirm stores replaces_subscription_id = the server-locked source', rowX.replaces_subscription_id === paidX.src);
    // Fresh pending chain for company Y (so the one-open index is free there).
    const pendY = (await q1(`INSERT INTO subscriptions (status, company_id, plan, currency, billing_interval, current_period_start, current_period_end, period_amount)
                            VALUES ('pending_payment', $1, 'gold', 'USD', 'monthly', now(), now() + interval '1 month', 67) RETURNING id`, [paidY.co])).id;
    const invY = (await q1(`INSERT INTO invoices (company_id, subscription_id, plan, billing_interval, currency, amount, period_start, period_end, status, issue_date, due_date)
                           SELECT company_id, id, plan, billing_interval, currency, period_amount, current_period_start, current_period_end, 'issued', now(), now()
                           FROM subscriptions WHERE id = $1 RETURNING id`, [pendY])).id;
    check("replaces referencing ANOTHER company's subscription fails (composite FK)",
      await expectFail(`INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, replaces_subscription_id, created_at, expires_at)
                        VALUES ($1, $2, $3, $4, now(), now() + interval '30 minutes')`, [paidY.co, pendY, invY, paidX.src], 'subscription_purchases_replaces_fk'));
    const cancelledY = (await q1(`INSERT INTO subscriptions (status, company_id, plan, currency, billing_interval, current_period_start, current_period_end, period_amount)
                                 VALUES ('cancelled', $1, 'bronze', 'USD', 'monthly', now(), now() + interval '1 month', 32) RETURNING id`, [paidY.co])).id;
    check('replaces referencing a NON-active subscription at INSERT fails (guard)',
      await expectFail(`INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, replaces_subscription_id, created_at, expires_at)
                        VALUES ($1, $2, $3, $4, now(), now() + interval '30 minutes')`, [paidY.co, pendY, invY, cancelledY], 'must reference an active subscription'));
    check('replaces_subscription_id is immutable after insert',
      await expectFail(`UPDATE subscription_purchases SET replaces_subscription_id = NULL WHERE id = $1`, [pX.purchaseId], 'immutable'));
    check('RESTRICT: the replaced (source) subscription cannot be deleted while referenced',
      await expectFail(`DELETE FROM subscriptions WHERE id = $1`, [paidX.src]));
    // The not-self CHECK and the partial unique index, proven independently of
    // the INSERT guard trigger (session_replication_role = replica disables
    // triggers; CHECK constraints and unique indexes stay enforced).
    await setup.query(`SET session_replication_role = replica`);
    check('replaces = subscription_id fails (not-self CHECK)',
      await expectFail(`INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, replaces_subscription_id, created_at, expires_at)
                        VALUES ($1, $2, $3, $2, now(), now() + interval '30 minutes')`, [paidY.co, pendY, invY], 'replaces_not_self'));
    let dupBlocked = false;
    try {
      await setup.query('BEGIN');
      const s1 = (await q1(`INSERT INTO subscriptions (status, company_id, plan, currency, billing_interval, current_period_start, current_period_end, period_amount)
                           VALUES ('abandoned', $1, 'gold', 'USD', 'monthly', now(), now() + interval '1 month', 67) RETURNING id`, [paidY.co])).id;
      const i1 = (await q1(`INSERT INTO invoices (company_id, subscription_id, plan, billing_interval, currency, amount, period_start, period_end, status, issue_date, due_date)
                           SELECT company_id, id, plan, billing_interval, currency, period_amount, current_period_start, current_period_end, 'void', now(), now()
                           FROM subscriptions WHERE id = $1 RETURNING id`, [s1])).id;
      await setup.query(`INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, replaces_subscription_id, status, created_at, expires_at, completed_at)
                         VALUES ($1, $2, $3, $4, 'completed', now(), now() + interval '1 minute', now())`, [paidY.co, s1, i1, paidY.src]);
      const s2 = (await q1(`INSERT INTO subscriptions (status, company_id, plan, currency, billing_interval, current_period_start, current_period_end, period_amount)
                           VALUES ('abandoned', $1, 'silver', 'USD', 'monthly', now(), now() + interval '1 month', 39) RETURNING id`, [paidY.co])).id;
      const i2 = (await q1(`INSERT INTO invoices (company_id, subscription_id, plan, billing_interval, currency, amount, period_start, period_end, status, issue_date, due_date)
                           SELECT company_id, id, plan, billing_interval, currency, period_amount, current_period_start, current_period_end, 'void', now(), now()
                           FROM subscriptions WHERE id = $1 RETURNING id`, [s2])).id;
      await setup.query(`INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, replaces_subscription_id, status, created_at, expires_at, completed_at)
                         VALUES ($1, $2, $3, $4, 'completed', now(), now() + interval '1 minute', now())`, [paidY.co, s2, i2, paidY.src]);
    } catch (err) {
      dupBlocked = err.code === '23505' && err.constraint === 'subscription_purchases_one_completed_per_replaced';
    } finally {
      await setup.query('ROLLBACK');
      await setup.query(`SET session_replication_role = origin`);
    }
    check('a second COMPLETED purchase replacing the same subscription fails (one_completed_per_replaced)', dupBlocked);
    const purchaseSrc = (await q1(`SELECT prosrc FROM pg_proc WHERE proname = 'subscription_purchases_guard_mutation'`)).prosrc;
    check('the purchase guard still stamps completed_at/voided_at with clock_timestamp()',
      /completed_at := clock_timestamp\(\)/.test(purchaseSrc) && /voided_at := clock_timestamp\(\)/.test(purchaseSrc));

    // ======================================================================
    console.log('\n== B. T-DB-2 / T-DB-3 — the six allowed same-interval paths ==');
    const paths = [
      ['bronze', 'silver', 'monthly'], ['bronze', 'gold', 'monthly'], ['silver', 'gold', 'monthly'],
      ['bronze', 'silver', 'annual'], ['bronze', 'gold', 'annual'], ['silver', 'gold', 'annual'],
    ];
    for (const [from, to, interval] of paths) {
      const { co, src } = await makePaid(`path ${from}->${to} ${interval}`, from, interval);
      const p = await upgrade(co, to, interval, src);
      const s0 = await state(co);
      const unchanged = s0.company.plan === from && s0.company.subscription_status === 'active' &&
        s0.subs.find((x) => x.id === src).status === 'active' && planLevelOf(s0.company.plan) === planLevelOf(from);
      const chain = await q1(
        `SELECT s.current_period_start = i.issue_date AND i.issue_date = i.due_date AND i.issue_date = i.period_start
                  AND i.period_start = sp.created_at AS anchors_equal,
                sp.expires_at - sp.created_at = interval '30 minutes' AS window_30,
                s.billing_interval AS pending_interval, s.plan AS pending_plan
         FROM subscription_purchases sp JOIN subscriptions s ON s.id = sp.subscription_id JOIN invoices i ON i.id = sp.invoice_id
         WHERE sp.id = $1`, [p.purchaseId]);
      // Failure then retry, then success.
      const c1 = await sp.startCheckout(pool, co, p.purchaseId);
      await resolveCheckoutSessionCore(pool, c1.sessionId, 'failed');
      const sF = await state(co);
      const c2 = await sp.startCheckout(pool, co, p.purchaseId);
      const r = await resolveCheckoutSessionCore(pool, c2.sessionId, 'succeeded');
      const s1 = await state(co);
      const newSub = s1.subs.find((x) => x.id === p.subscriptionId);
      const money = await q1(
        `SELECT s.period_amount::text AS s, i.amount::text AS i, pa.amount::text AS a
         FROM subscriptions s JOIN invoices i ON i.subscription_id = s.id JOIN payment_attempts pa ON pa.invoice_id = i.id
         WHERE s.id = $1 AND pa.status = 'succeeded'`, [p.subscriptionId]);
      check(`${from} -> ${to} (${interval}): confirm changes nothing; failure keeps the source; success supersedes the source, activates the target, pays the invoice, sets companies.plan`,
        unchanged && chain.anchors_equal && chain.window_30 && chain.pending_interval === interval && chain.pending_plan === to &&
        sF.subs.find((x) => x.id === src).status === 'active' && sF.company.plan === from &&
        r.kind === 'ok' && r.purchaseApplied && s1.subs.find((x) => x.id === src).status === 'superseded' &&
        newSub.status === 'active' && newSub.billing_interval === interval && s1.company.plan === to && s1.company.subscription_status === 'active' &&
        live(s1).length === 1 && s1.purchases.find((x) => x.id === p.purchaseId).status === 'completed' &&
        s1.invoices.find((x) => x.subscription_id === p.subscriptionId).status === 'paid' &&
        planLevelOf(s1.company.plan) > planLevelOf(from) &&
        money && money.s === money.i && money.i === money.a,
        { from, to, interval, chain, company: s1.company, money });
    }
    {
      const { co, src } = await makePaid('cross interval', 'bronze', 'monthly');
      const p = await upgrade(co, 'gold', 'monthly', src);
      const before = await writeCounts();
      let code;
      try { await upgrade(co, 'gold', 'annual', src); } catch (e) { code = e.code; }
      const after = await writeCounts();
      const s = await state(co);
      check('T-DB-3: a cross-interval confirm against a live chain -> INTERVAL_CHANGE_NOT_SUPPORTED; the open chain and every row unchanged',
        code === 'INTERVAL_CHANGE_NOT_SUPPORTED' && JSON.stringify(before) === JSON.stringify(after) &&
        s.purchases.find((x) => x.id === p.purchaseId).status === 'open', { code });
    }
    {
      const { co, src } = await makePaid('forbidden', 'silver', 'annual');
      const codes = {};
      for (const [plan, interval] of [['bronze', 'annual'], ['silver', 'annual'], ['silver', 'monthly'], ['gold', 'monthly']]) {
        try { await upgrade(co, plan, interval, src); codes[`${plan}/${interval}`] = 'created'; } catch (e) { codes[`${plan}/${interval}`] = e.code; }
      }
      const s = await state(co);
      check('downgrade / same plan / same plan other interval / cross-interval are rejected with zero writes',
        codes['bronze/annual'] === 'NOT_AN_UPGRADE' && codes['silver/annual'] === 'NOT_AN_UPGRADE' && codes['silver/monthly'] === 'NOT_AN_UPGRADE' &&
        codes['gold/monthly'] === 'INTERVAL_CHANGE_NOT_SUPPORTED' && s.purchases.length === 0 && s.subs.length === 1, codes);
    }

    // ======================================================================
    console.log('\n== C. Concurrency ==');
    {
      const { co, src } = await makePaid('R1 identical', 'bronze', 'monthly');
      const r = await Promise.allSettled(Array.from({ length: 20 }, () => upgrade(co, 'gold', 'monthly', src)));
      r.forEach((x) => x.status === 'rejected' && noteIfDeadlock(x.reason, 'R1'));
      const s = await state(co);
      check('T-RACE-1: 20 parallel identical upgrade confirms -> 1 purchase, 1 invoice, 1 pending row',
        s.purchases.length === 1 && s.invoices.length === 1 && count(s.subs, (x) => x.status === 'pending_payment') === 1 && r.every((x) => x.status === 'fulfilled'),
        { purchases: s.purchases.length, rejected: r.filter((x) => x.status === 'rejected').map((x) => x.reason.code) });
    }
    {
      const { co, src } = await makePaid('R2 switches', 'bronze', 'annual');
      const r = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => upgrade(co, i % 2 ? 'gold' : 'silver', 'annual', src)));
      r.forEach((x) => x.status === 'rejected' && noteIfDeadlock(x.reason, 'R2'));
      const s = await state(co);
      check('T-RACE-2: parallel target switches -> exactly 1 open; every other chain void/abandoned; source still active',
        count(s.purchases, (x) => x.status === 'open') === 1 && count(s.purchases, (x) => x.status === 'void') === s.purchases.length - 1 &&
        count(s.invoices, (x) => x.status === 'issued') === 1 && count(s.subs, (x) => x.status === 'pending_payment') === 1 &&
        s.subs.find((x) => x.id === src).status === 'active', { purchases: s.purchases.map((x) => x.status) });
    }
    {
      // T-RACE-3: Bronze -> Silver settles; then a STALE Gold confirm asserting Bronze.
      const { co, src } = await makePaid('R3 stale', 'bronze', 'monthly');
      const pS = await upgrade(co, 'silver', 'monthly', src);
      const cS = await sp.startCheckout(pool, co, pS.purchaseId);
      await resolveCheckoutSessionCore(pool, cS.sessionId, 'succeeded');
      const before = await writeCounts();
      let code;
      try { await upgrade(co, 'gold', 'monthly', src); } catch (e) { code = e.code; }
      const after = await writeCounts();
      const s = await state(co);
      check('T-RACE-3: after Bronze->Silver settles, a stale Gold confirm (expected = Bronze) -> UPGRADE_CONTEXT_STALE, zero writes; never Silver->Gold',
        code === 'UPGRADE_CONTEXT_STALE' && JSON.stringify(before) === JSON.stringify(after) && s.company.plan === 'silver' &&
        s.subs.find((x) => x.id === src).status === 'superseded' && !s.purchases.some((x) => x.status === 'open'), { code });
    }
    {
      // T-RACE-4: the stale Gold confirm reaches the lock first, then the Silver success.
      const { co, src } = await makePaid('R4', 'bronze', 'monthly');
      const pS = await upgrade(co, 'silver', 'monthly', src);
      const cS = await sp.startCheckout(pool, co, pS.purchaseId);
      const pG = await upgrade(co, 'gold', 'monthly', src);
      const res = await resolveCheckoutSessionCore(pool, cS.sessionId, 'succeeded');
      const s = await state(co);
      check('T-RACE-4: the later Gold confirm voids the Silver chain; the Silver success -> 409, zero writes; one open chain (Gold)',
        pG.kind === 'created' && pG.voided && pG.voided.reason === 'superseded' && res.kind === 'conflict' &&
        s.purchases.find((x) => x.id === pS.purchaseId).status === 'void' && s.sessions.find((x) => x.id === cS.sessionId).status === 'cancelled' &&
        count(s.purchases, (x) => x.status === 'open') === 1 && s.company.plan === 'bronze' && s.subs.find((x) => x.id === src).status === 'active');
    }
    {
      // T-RACE-5: parallel checkouts; fail -> retry x3 -> success.
      const { co, src } = await makePaid('R5', 'bronze', 'monthly');
      const p = await upgrade(co, 'gold', 'monthly', src);
      const r = await Promise.allSettled(Array.from({ length: 10 }, () => sp.startCheckout(pool, co, p.purchaseId)));
      r.forEach((x) => x.status === 'rejected' && noteIfDeadlock(x.reason, 'R5'));
      const one = new Set(r.filter((x) => x.status === 'fulfilled').map((x) => x.value.sessionId)).size === 1;
      let sid = r[0].value.sessionId;
      for (let i = 0; i < 3; i += 1) {
        await resolveCheckoutSessionCore(pool, sid, 'failed');
        sid = (await sp.startCheckout(pool, co, p.purchaseId)).sessionId;
      }
      await resolveCheckoutSessionCore(pool, sid, 'succeeded');
      const keys = (await setup.query(`SELECT idempotency_key, status FROM payment_attempts WHERE company_id = $1 ORDER BY created_at`, [co])).rows;
      check('T-RACE-5: 10 parallel checkouts -> one session; fail/retry x3 then success -> keys b7:<id>:1..4, exactly one succeeded',
        one && keys.length === 4 && keys.every((k, i) => k.idempotency_key === `b7:${p.purchaseId}:${i + 1}`) && count(keys, (k) => k.status === 'succeeded') === 1, keys);
    }
    {
      // T-RACE-6: 10 parallel success resolves + a replay.
      const { co, src } = await makePaid('R6', 'silver', 'annual');
      const p = await upgrade(co, 'gold', 'annual', src);
      const c = await sp.startCheckout(pool, co, p.purchaseId);
      const r = await Promise.allSettled(Array.from({ length: 10 }, () => resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded')));
      r.forEach((x) => x.status === 'rejected' && noteIfDeadlock(x.reason, 'R6'));
      const before = await writeCounts();
      const replay = await resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded');
      const after = await writeCounts();
      const s = await state(co);
      check('T-RACE-6: 10 parallel success resolves -> exactly 1 apply; replay -> conflict with zero writes',
        r.filter((x) => x.status === 'fulfilled' && x.value.kind === 'ok' && x.value.purchaseApplied).length === 1 &&
        count(s.subs, (x) => x.status === 'superseded') === 1 && live(s).length === 1 && s.company.plan === 'gold' &&
        replay.kind === 'conflict' && JSON.stringify(before) === JSON.stringify(after));
    }
    {
      // T-RACE-7: success vs admin actions, both orders.
      let ok = true;
      for (let i = 0; i < ITERATIONS; i += 1) {
        const kind = ['activate', 'suspend', 'invoice'][i % 3];
        const { co, src } = await makePaid(`R7 ${kind} ${i}`, 'bronze', 'monthly');
        const p = await upgrade(co, 'gold', 'monthly', src);
        const c = await sp.startCheckout(pool, co, p.purchaseId);
        const adminCall = () =>
          kind === 'activate'
            ? invoke(adminController.activateSubscription, makeReq({ id: co }, { plan: 'silver', billing_interval: 'monthly', currency: 'USD', period_amount: 39 }))
            : kind === 'suspend'
            ? invoke(adminController.updateCompany, makeReq({ id: co }, { subscription_status: 'suspended' }))
            : invoke(adminController.createSubscriptionInvoice, makeReq({ id: co }, {}));
        const [adm, res] = await Promise.all(
          i % 2 ? [adminCall(), resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded').catch((e) => ({ kind: 'error', e }))]
                : [sleep(5).then(adminCall), resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded').catch((e) => ({ kind: 'error', e }))]
        );
        if (res.kind === 'error') noteIfDeadlock(res.e, 'R7');
        const s = await state(co);
        const paidUnapplied = s.invoices.some((x) => x.subscription_id === p.subscriptionId && x.status === 'paid') && s.company.plan !== 'gold';
        const applied = res.kind === 'ok' && res.purchaseApplied;
        let coherent = live(s).length === 1 && !paidUnapplied;
        if (applied) {
          // The admin action ran on the new state (or was blocked before the apply).
          if (kind === 'invoice' && adm.status === 201) coherent = coherent && s.invoices.some((x) => x.subscription_id === p.subscriptionId && x.status === 'issued');
          if (kind === 'activate') coherent = coherent && adm.status === 409;
        } else {
          coherent = coherent && adm.status === 409 && res.kind !== 'error';
        }
        if (!coherent) { ok = false; console.log(`    R7[${i}] ${kind}: admin=${adm.status}/${adm.body && adm.body.code} res=${res.kind}`, JSON.stringify(s.company)); }
      }
      check(`T-RACE-7: success vs activate / suspend / issue-invoice (${ITERATIONS} iterations, both orders): never paid-and-unapplied, never two live rows`, ok);
    }
    {
      // T-RACE-8: an issued SOURCE invoice with an initiated attempt/session:
      // non-purchase settlement vs upgrade confirm, both orders.
      let ok = true;
      for (let i = 0; i < ITERATIONS; i += 1) {
        const { co, src } = await makePaid(`R8 ${i}`, 'bronze', 'monthly');
        const inv = await invoke(adminController.createSubscriptionInvoice, makeReq({ id: co }, {}));
        const att = await q1(
          `INSERT INTO payment_attempts (invoice_id, company_id, subscription_id, amount, currency, plan, billing_interval, period_start, period_end, idempotency_key, status)
           SELECT id, company_id, subscription_id, amount, currency, plan, billing_interval, period_start, period_end, $2, 'initiated'
           FROM invoices WHERE id = $1 RETURNING id`, [inv.body.invoice.id, `smoke-b8-r8-${RUN_ID}-${i}`]);
        const sess = await q1(`INSERT INTO payment_checkout_sessions (payment_attempt_id, status) VALUES ($1, 'pending') RETURNING id`, [att.id]);
        const [settle, conf] = await Promise.all(
          i % 2 ? [resolveCheckoutSessionCore(pool, sess.id, 'succeeded').catch((e) => ({ kind: 'error', e })), upgrade(co, 'gold', 'monthly', src).then((v) => ({ v }), (e) => ({ e }))]
                : [sleep(5).then(() => resolveCheckoutSessionCore(pool, sess.id, 'succeeded')).catch((e) => ({ kind: 'error', e })), upgrade(co, 'gold', 'monthly', src).then((v) => ({ v }), (e) => ({ e }))]
        );
        if (conf.e) noteIfDeadlock(conf.e, 'R8');
        const s = await state(co);
        const srcInvoice = s.invoices.find((x) => x.id === inv.body.invoice.id);
        const blocked = conf.e && conf.e.code === 'UNPAID_INVOICE' && s.purchases.length === 0;
        const createdAfterPaid = conf.v && conf.v.kind === 'created' && srcInvoice.status === 'paid';
        if (!(settle.kind === 'ok' && srcInvoice.status === 'paid' && (blocked || createdAfterPaid))) {
          ok = false;
          console.log(`    R8[${i}] settle=${settle.kind} conf=${conf.e ? conf.e.code : conf.v.kind} inv=${srcInvoice.status}`);
        }
      }
      check(`T-RACE-8: non-purchase settlement of an issued source invoice vs upgrade confirm (${ITERATIONS} iterations): UNPAID_INVOICE or created-after-paid, never an upgrade while the source invoice is issued`, ok);
    }
    {
      // T-ADM-3-DB: expired upgrade chain; createSubscriptionInvoice + confirm in parallel.
      let ok = true;
      for (let i = 0; i < ITERATIONS; i += 1) {
        const { co, src } = await makePaid(`ADM3 ${i}`, 'bronze', 'monthly');
        const fx = await shortWindowUpgrade(co, src, 300, 'gold', 'monthly');
        await sleep(600);
        const [inv, conf] = await Promise.all(
          i % 2 ? [invoke(adminController.createSubscriptionInvoice, makeReq({ id: co }, {})), upgrade(co, 'silver', 'monthly', src).then((v) => ({ v }), (e) => ({ e }))]
                : [sleep(5).then(() => invoke(adminController.createSubscriptionInvoice, makeReq({ id: co }, {}))), upgrade(co, 'silver', 'monthly', src).then((v) => ({ v }), (e) => ({ e }))]
        );
        if (conf.e) noteIfDeadlock(conf.e, 'ADM3');
        const s = await state(co);
        const fxP = s.purchases.find((x) => x.id === fx.purchaseId);
        const invoiceFirst = inv.status === 201 && fxP.status === 'void' && conf.e && conf.e.code === 'UNPAID_INVOICE';
        const confirmFirst = conf.v && conf.v.kind === 'created' && conf.v.voided && conf.v.voided.reason === 'expired_superseded' &&
          inv.status === 409 && inv.body && inv.body.code === 'OPEN_CUSTOMER_PURCHASE';
        if (invoiceFirst === confirmFirst) { ok = false; console.log(`    ADM3[${i}] inv=${inv.status}/${inv.body && inv.body.code} conf=${conf.e ? conf.e.code : conf.v.kind}`); }
        if (invoiceFirst) {
          const audit = (await setup.query(`SELECT new_values FROM audit_logs WHERE company_id = $1 AND action = 'subscription_purchase_voided'`, [co])).rows;
          if (!(audit.length === 1 && audit[0].new_values.reason === 'expired_admin_action' && audit[0].new_values.admin_action === 'create_subscription_invoice')) ok = false;
        }
      }
      check(`T-ADM-3-DB: expired upgrade chain vs createSubscriptionInvoice + confirm (${ITERATIONS} iterations): exactly one order wins, zero deadlocks`, ok);
    }

    // ======================================================================
    console.log('\n== D. Deadline and lock-wait (T-DL-1 / T-DL-2) ==');
    async function lockWait(label, windowMs, runB) {
      const { co, src } = await makePaid(`lock-wait ${label}`, 'bronze', 'monthly');
      const fx = await shortWindowUpgrade(co, src, windowMs, 'gold', 'monthly');
      const c = await sp.startCheckout(pool, co, fx.purchaseId);
      const a = track(new Client(clientConfig(DB_NAME)));
      await a.connect();
      await a.query('BEGIN');
      await a.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [co]);
      const b = track(new Client(clientConfig(DB_NAME)));
      await b.connect();
      await b.query(`SET lock_timeout = '15s'`);
      const rec = {};
      const pB = runB({ co, src, fx, c, db: recordingConnectable(b, rec) }).then((v) => ({ v }), (e) => ({ e }));
      await sleep(Math.max(0, fx.expiresAt.getTime() - Date.now()) + 700);
      await a.query('COMMIT');
      const out = await pB;
      await a.end();
      await b.end();
      return { co, src, fx, c, rec, out };
    }
    const dlR = await lockWait('resolve', 1500, ({ c, db }) => resolveCheckoutSessionCore(db, c.sessionId, 'succeeded'));
    const sR = await state(dlR.co);
    check('T-DL-1: an upgrade success that waited on the lock past the deadline -> SESSION_EXPIRED, source still active, plan unchanged',
      dlR.out.v && dlR.out.v.code === 'SESSION_EXPIRED' && new Date(dlR.rec.txnNow.t) < dlR.fx.expiresAt &&
      sR.subs.find((x) => x.id === dlR.src).status === 'active' && sR.company.plan === 'bronze', dlR.out);
    const dlC = await lockWait('checkout', 1500, ({ co, fx, db }) => sp.startCheckout(db, co, fx.purchaseId));
    check('T-DL-1: an upgrade checkout that waited past the deadline -> PURCHASE_EXPIRED', dlC.out.e && dlC.out.e.code === 'PURCHASE_EXPIRED');
    const dlP = await lockWait('confirm replay', 1500, ({ co, src, db }) => upgrade(co, 'gold', 'monthly', src, db));
    check('T-DL-1: a same-selection confirm that waited past the deadline -> void (expired_superseded) + re-create',
      dlP.out.v && dlP.out.v.kind === 'created' && dlP.out.v.voided && dlP.out.v.voided.reason === 'expired_superseded');
    {
      const { co, src } = await makePaid('lock-wait admin suspend', 'bronze', 'monthly');
      const fx = await shortWindowUpgrade(co, src, 1500, 'gold', 'monthly');
      const a = track(new Client(clientConfig(DB_NAME)));
      await a.connect();
      await a.query('BEGIN');
      await a.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [co]);
      const pU = invoke(adminController.updateCompany, makeReq({ id: co }, { subscription_status: 'suspended' }));
      await sleep(Math.max(0, fx.expiresAt.getTime() - Date.now()) + 700);
      await a.query('COMMIT');
      const out = await pU;
      await a.end();
      const s = await state(co);
      check('T-DL-1: an admin suspend that waited past the deadline -> void (expired_admin_action) + suspend; source untouched',
        out.status === 200 && s.company.subscription_status === 'suspended' && s.purchases.find((x) => x.id === fx.purchaseId).status === 'void' &&
        s.subs.find((x) => x.id === src).status === 'active');
    }
    {
      let ok = true;
      let applied = 0;
      let voided = 0;
      for (let i = 0; i < ITERATIONS * 2; i += 1) {
        const { co, src } = await makePaid(`DL2 ${i}`, 'bronze', 'monthly');
        const fx = await shortWindowUpgrade(co, src, 400, 'gold', 'monthly');
        const c = await sp.startCheckout(pool, co, fx.purchaseId);
        await sleep(Math.max(0, fx.expiresAt.getTime() - Date.now()) - 15 + (i % 3) * 15);
        const adminCall = i % 2
          ? invoke(adminController.updateCompany, makeReq({ id: co }, { subscription_status: 'suspended' }))
          : invoke(adminController.createSubscriptionInvoice, makeReq({ id: co }, {}));
        const [adm, res] = await Promise.all(
          i % 4 < 2 ? [adminCall, resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded').catch((e) => ({ kind: 'error', e }))]
                    : [sleep(3).then(() => adminCall), resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded').catch((e) => ({ kind: 'error', e }))]
        );
        if (res.kind === 'error') noteIfDeadlock(res.e, 'DL2');
        const s = await state(co);
        const p = s.purchases.find((x) => x.id === fx.purchaseId);
        const A = p.status === 'completed' && s.subs.find((x) => x.id === src).status === 'superseded' && s.company.plan === 'gold';
        const B = p.status === 'void' && s.subs.find((x) => x.id === src).status === 'active' && s.company.plan === 'bronze' && res.kind === 'conflict';
        const C = p.status === 'open' && res.kind === 'conflict' && res.code === 'SESSION_EXPIRED' && adm.status === 409;
        if (A) applied += 1;
        if (B) voided += 1;
        if ([A, B, C].filter(Boolean).length !== 1 || live(s).length !== 1) { ok = false; console.log(`    DL2[${i}] adm=${adm.status} res=${res.kind}/${res.code} p=${p.status}`); }
      }
      check(`T-DL-2: admin cleanup vs upgrade success at the deadline (${ITERATIONS * 2} iterations): exactly one outcome, never both (applied=${applied}, voided=${voided})`, ok);
    }

    // ----------------------------------------------------------------------
    // T-DL-3 / T-DL-4 (review B8-R1): the SOURCE subscription row is held past
    // the purchase deadline. The request under test takes company -> purchase
    // (lockOpenPurchase reads the clock: still unexpired) and then waits on the
    // source row. Only the post-source-lock clock read may decide.
    async function sourceLockWait(label, runB) {
      const { co, src } = await makePaid(`source-wait ${label}`, 'bronze', 'monthly');
      const fx = await shortWindowUpgrade(co, src, 1500, 'gold', 'monthly');
      const a = track(new Client(clientConfig(DB_NAME)));
      await a.connect();
      await a.query('BEGIN');
      await a.query(`SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE`, [src]);
      const pB = runB({ co, src, fx }).then((v) => ({ v }), (e) => ({ e }));
      // Prove the wait began BEFORE the deadline, on the source row.
      let waitingBeforeDeadline = false;
      for (let k = 0; k < 40 && !waitingBeforeDeadline; k += 1) {
        await sleep(25);
        const w = await q1(
          `SELECT count(*)::int AS n, bool_and(clock_timestamp() < $1::timestamptz) AS before
           FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query LIKE '%FROM subscriptions WHERE%FOR UPDATE%' AND pid <> pg_backend_pid()`,
          [fx.expiresAt.toISOString()]
        );
        waitingBeforeDeadline = w.n >= 1 && w.before === true;
      }
      await sleep(Math.max(0, fx.expiresAt.getTime() - Date.now()) + 700);
      await a.query('COMMIT');
      const out = await pB;
      await a.end();
      return { co, src, fx, out, waitingBeforeDeadline, state: await state(co) };
    }
    {
      const clockReads = [];
      const r = await sourceLockWait('confirm', async ({ co, src }) => {
        const b = track(new Client(clientConfig(DB_NAME)));
        await b.connect();
        await b.query(`SET lock_timeout = '15s'`);
        const query = async (sql, params) => {
          const res = await b.query(sql, params);
          if (typeof sql === 'string' && sql.includes('clock_timestamp() < expires_at AS unexpired')) clockReads.push(res.rows[0] && res.rows[0].unexpired);
          return res;
        };
        const db = { query, connect: async () => ({ query, release: () => {} }) };
        try {
          return await upgrade(co, 'gold', 'monthly', src, db);
        } finally {
          await b.end();
        }
      });
      const old = r.state.purchases.find((x) => x.id === r.fx.purchaseId);
      const fresh = r.state.purchases.filter((x) => x.id !== r.fx.purchaseId);
      check('T-DL-3 (B8-R1): identical upgrade confirm that waited on the SOURCE lock past the deadline -> no replay; old chain void (expired_superseded), new open purchase',
        r.waitingBeforeDeadline && clockReads[0] === true && clockReads[clockReads.length - 1] === false &&
        r.out.v && r.out.v.kind === 'created' && r.out.v.purchaseId !== r.fx.purchaseId &&
        r.out.v.voided && r.out.v.voided.reason === 'expired_superseded' &&
        old.status === 'void' && fresh.length === 1 && fresh[0].status === 'open' && fresh[0].replaces_subscription_id === r.src &&
        r.state.subs.find((x) => x.id === r.src).status === 'active' && r.state.company.plan === 'bronze',
        { waiting: r.waitingBeforeDeadline, clockReads, out: r.out.e ? String(r.out.e.code || r.out.e.message) : r.out.v });
    }
    {
      const r = await sourceLockWait('admin invoice', async ({ co }) =>
        invoke(adminController.createSubscriptionInvoice, makeReq({ id: co }, {})));
      const old = r.state.purchases.find((x) => x.id === r.fx.purchaseId);
      check('T-DL-4 (B8-R1): createSubscriptionInvoice that waited on the SOURCE lock past the deadline -> expired chain voided + invoice issued (201), never OPEN_CUSTOMER_PURCHASE',
        r.waitingBeforeDeadline && r.out.v && r.out.v.status === 201 &&
        old.status === 'void' && r.state.invoices.some((x) => x.subscription_id === r.src && x.status === 'issued') &&
        r.state.subs.find((x) => x.id === r.src).status === 'active',
        { waiting: r.waitingBeforeDeadline, status: r.out.v && r.out.v.status, body: r.out.v && r.out.v.body, purchase: old && old.status });
    }

    // ======================================================================
    console.log('\n== E. Settlement timestamps after lock waits (T-TIME-1 / T-TIME-2) ==');
    {
      const { co, src } = await makePaid('time upgrade', 'bronze', 'monthly');
      const p = await upgrade(co, 'gold', 'monthly', src);
      const c = await sp.startCheckout(pool, co, p.purchaseId);
      const a = track(new Client(clientConfig(DB_NAME)));
      await a.connect();
      await a.query('BEGIN');
      await a.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [co]);
      const b = track(new Client(clientConfig(DB_NAME)));
      await b.connect();
      const rec = {};
      const pB = resolveCheckoutSessionCore(recordingConnectable(b, rec), c.sessionId, 'succeeded');
      await sleep(3000);
      const release = (await a.query('SELECT clock_timestamp() AS t')).rows[0].t;
      await a.query('COMMIT');
      const out = await pB;
      await a.end();
      await b.end();
      const t = await q1(
        `SELECT i.payment_date, pa.succeeded_at, pcs.resolved_at, sp.completed_at
         FROM subscription_purchases sp JOIN invoices i ON i.id = sp.invoice_id
         JOIN payment_attempts pa ON pa.invoice_id = i.id AND pa.status = 'succeeded'
         JOIN payment_checkout_sessions pcs ON pcs.payment_attempt_id = pa.id WHERE sp.id = $1`, [p.purchaseId]);
      const txnNow = new Date(rec.txnNow.t);
      const all = [t.payment_date, t.succeeded_at, t.resolved_at, t.completed_at].map((x) => new Date(x));
      check('T-TIME-1: upgrade success after a 3 s lock wait — payment_date, succeeded_at, resolved_at, completed_at are all after the waiting txn now() and >= the lock release',
        out.kind === 'ok' && all.every((d) => d > txnNow && d >= new Date(release)), { txnNow, release, t });
    }
    {
      const { co, src } = await makePaid('time failed', 'bronze', 'monthly');
      const p = await upgrade(co, 'gold', 'monthly', src);
      const c = await sp.startCheckout(pool, co, p.purchaseId);
      const a = track(new Client(clientConfig(DB_NAME)));
      await a.connect();
      await a.query('BEGIN');
      await a.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [co]);
      const b = track(new Client(clientConfig(DB_NAME)));
      await b.connect();
      const rec = {};
      const pB = resolveCheckoutSessionCore(recordingConnectable(b, rec), c.sessionId, 'failed');
      await sleep(2000);
      const release = (await a.query('SELECT clock_timestamp() AS t')).rows[0].t;
      await a.query('COMMIT');
      await pB;
      await a.end();
      await b.end();
      const t = await q1(`SELECT pa.failed_at, pcs.resolved_at FROM payment_attempts pa JOIN payment_checkout_sessions pcs ON pcs.payment_attempt_id = pa.id WHERE pa.id = $1`, [c.attemptId]);
      check('T-TIME-1: a failed outcome after a lock wait — failed_at and resolved_at >= the lock release',
        new Date(t.failed_at) >= new Date(release) && new Date(t.resolved_at) >= new Date(release) && new Date(t.failed_at) > new Date(rec.txnNow.t), { t, release });
    }
    {
      // B6 non-purchase path under an INVOICE-lock wait.
      const { co } = await makePaid('time b6', 'bronze', 'monthly');
      const inv = await invoke(adminController.createSubscriptionInvoice, makeReq({ id: co }, {}));
      const att = await q1(
        `INSERT INTO payment_attempts (invoice_id, company_id, subscription_id, amount, currency, plan, billing_interval, period_start, period_end, idempotency_key, status)
         SELECT id, company_id, subscription_id, amount, currency, plan, billing_interval, period_start, period_end, $2, 'initiated'
         FROM invoices WHERE id = $1 RETURNING id`, [inv.body.invoice.id, `smoke-b8-time-${RUN_ID}`]);
      const sess = await q1(`INSERT INTO payment_checkout_sessions (payment_attempt_id, status) VALUES ($1, 'pending') RETURNING id`, [att.id]);
      const a = track(new Client(clientConfig(DB_NAME)));
      await a.connect();
      await a.query('BEGIN');
      await a.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [inv.body.invoice.id]);
      const b = track(new Client(clientConfig(DB_NAME)));
      await b.connect();
      const rec = {};
      const pB = resolveCheckoutSessionCore(recordingConnectable(b, rec), sess.id, 'succeeded');
      await sleep(2000);
      const release = (await a.query('SELECT clock_timestamp() AS t')).rows[0].t;
      await a.query('COMMIT');
      const out = await pB;
      await a.end();
      await b.end();
      const t = await q1(
        `SELECT i.payment_date, pa.succeeded_at, pcs.resolved_at FROM invoices i JOIN payment_attempts pa ON pa.invoice_id = i.id
         JOIN payment_checkout_sessions pcs ON pcs.payment_attempt_id = pa.id WHERE i.id = $1`, [inv.body.invoice.id]);
      check('T-TIME-1: the B6 non-purchase path after an invoice-lock wait — payment_date, succeeded_at, resolved_at >= the lock release',
        out.kind === 'ok' && [t.payment_date, t.succeeded_at, t.resolved_at].every((x) => new Date(x) >= new Date(release) && new Date(x) > new Date(rec.txnNow.t)), { t, release });
    }
    {
      const { extractFunctionBody } = require('./PREFLIGHT_B8_subscription_upgrade_schema_check');
      const m085 = fs.readFileSync(path.join(__dirname, 'MIGRATION_085_payment_simulator_foundation.sql'), 'utf8');
      const norm = (s) => s.replace(/\s+/g, ' ').trim();
      const attempts085 = extractFunctionBody(m085, 'payment_attempts_guard_mutation').replace(/:= now\(\);/g, ':= clock_timestamp();');
      const sessions085 = extractFunctionBody(m085, 'payment_checkout_sessions_guard_mutation')
        .replace('NEW.resolved_at := now();', 'NEW.resolved_at := clock_timestamp();')
        .replace('-- this unconditionally overwrites it with PostgreSQL transaction time.',
          "-- this unconditionally overwrites it with the real statement clock\n    -- (clock_timestamp(), MIGRATION_087), taken after the caller's locks.");
      const live1 = (await q1(`SELECT prosrc FROM pg_proc WHERE proname = 'payment_attempts_guard_mutation'`)).prosrc;
      const live2 = (await q1(`SELECT prosrc FROM pg_proc WHERE proname = 'payment_checkout_sessions_guard_mutation'`)).prosrc;
      check('T-TIME-2: the 087 attempt/session guard bodies equal MIGRATION_085 with only the stamp lines (and the stamp comment) changed',
        norm(live1) === norm(attempts085) && norm(live2) === norm(sessions085) && !/\bnow\(\)/.test(live1) && !/\bnow\(\)/.test(live2));
    }

    // ======================================================================
    console.log('\n== F. T-X-1 — cross-tenant ==');
    {
      const X = await makePaid('X tenant', 'bronze', 'monthly');
      const Y = await makePaid('Y tenant', 'bronze', 'monthly');
      const pX = await upgrade(X.co, 'gold', 'monthly', X.src);
      const cX = await sp.startCheckout(pool, X.co, pX.purchaseId);
      const beforeY = await state(Y.co);
      let code;
      try { await upgrade(Y.co, 'gold', 'monthly', X.src); } catch (e) { code = e.code; }
      let chk;
      try { await sp.startCheckout(pool, Y.co, pX.purchaseId); } catch (e) { chk = e.code; }
      await resolveCheckoutSessionCore(pool, cX.sessionId, 'succeeded');
      const afterY = await state(Y.co);
      check("T-X-1: Y asserting X's source -> UPGRADE_CONTEXT_STALE; Y cannot check out X's purchase (NOT_FOUND); settling X never touches Y",
        code === 'UPGRADE_CONTEXT_STALE' && chk === 'NOT_FOUND' && JSON.stringify(beforeY) === JSON.stringify(afterY));
    }

    // ======================================================================
    console.log('\n== G. T-COMPAT-2 — the old (B7) request shape against B8 ==');
    {
      const { co } = await makePaid('compat paid', 'bronze', 'monthly');
      const before = await writeCounts();
      let code;
      try { await trialConfirm(co, 'gold', 'monthly'); } catch (e) { code = e.code; }
      const after = await writeCounts();
      const trial = await newCompany('compat trial');
      const created = await trialConfirm(trial, 'silver', 'monthly');
      const row = await q1(`SELECT replaces_subscription_id FROM subscription_purchases WHERE id = $1`, [created.purchaseId]);
      check('T-COMPAT-2: {plan, billing_interval} from a paid admin -> UPGRADE_CONTEXT_STALE with zero writes; from a trial admin -> created (B7 path, replaces NULL)',
        code === 'UPGRADE_CONTEXT_STALE' && JSON.stringify(before) === JSON.stringify(after) && created.kind === 'created' && row.replaces_subscription_id === null);
    }
    {
      // /plans through the real controller: legacy fields stay B7, upgrade object present.
      const { co, src } = await makePaid('plans view', 'silver', 'annual');
      const out = await invoke(billingController.getPlans, makeReq({}, {}, { userId: 'u', companyId: co, role: 'admin' }));
      check('/plans for a paid admin: legacy can_purchase=false / NOT_ELIGIBLE; upgrade object = {interval annual, targets [gold], source id}',
        out.status === 200 && out.body.can_purchase === false && out.body.purchase_block_reason === 'NOT_ELIGIBLE' &&
        out.body.upgrade && out.body.upgrade.interval === 'annual' && JSON.stringify(out.body.upgrade.targets) === '["gold"]' &&
        out.body.upgrade.source_subscription_id === src && out.body.current.live_subscription.id === src, out.body && out.body.upgrade);
    }

    // ======================================================================
    console.log('\n== H. Preflight fixtures (T-PRE-1 … T-PRE-4) and T-REG-2 on a pre-087 database ==');
    const runPreflight = (db) => {
      const r = spawnSync(process.execPath, [path.join(__dirname, 'PREFLIGHT_B8_subscription_upgrade_schema_check.js')], {
        env: { ...process.env, DATABASE_URL: `postgres://${userPart}${rawHost}:${port}/${db}` },
        encoding: 'utf8',
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const pre1 = runPreflight(DB_086);
    check('T-PRE-1: PREFLIGHT_B8 passes on an 086 replay DB', pre1.code === 0 && pre1.out.includes('Preflight passed'), pre1.out.slice(-400));
    // T-PRE-2: a valid past_due row (a company with no other live row).
    const coPD = await newCompany('past_due fixture', { plan: 'bronze', subscription_status: 'active' }, setup086);
    await setup086.query(
      `INSERT INTO subscriptions (status, company_id, plan, currency, billing_interval, current_period_start, current_period_end, period_amount)
       VALUES ('past_due', $1, 'bronze', 'USD', 'monthly', now(), now() + interval '1 month', 32)`, [coPD]);
    const pre2 = runPreflight(DB_086);
    const { validateSubscriptionStatuses, validateSubscriptionColumns } = require('./PREFLIGHT_B8_subscription_upgrade_schema_check');
    check('T-PRE-2: a valid past_due row passes the preflight (status set incl. past_due; 14 columns)',
      pre2.code === 0 && validateSubscriptionStatuses(['active', 'past_due', 'cancelled', 'pending_payment', 'abandoned']).length === 0 &&
      validateSubscriptionStatuses(['superseded']).length === 1, pre2.out.slice(-400));
    const cols = (await setup086.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'subscriptions'`)).rows.map((r) => r.column_name);
    const colCheck = validateSubscriptionColumns(cols);
    check('T-PRE-2: the real subscriptions table has exactly the 14 expected columns', cols.length === 14 && colCheck.missing.length === 0 && colCheck.extra.length === 0, colCheck);

    // T-REG-2: an OPEN B7 trial purchase created BEFORE 087 (B8 code's trial
    // path is byte-identical to B7, so it runs on 086), then 087, then B8
    // settlement of it.
    const pool086 = new Pool({ connectionString: urlFor(DB_086) });
    extraPools.push(pool086);
    const trialCo = await newCompany('reg2 trial', {}, setup086);
    const trialP = await trialConfirm(trialCo, 'silver', 'monthly', pool086);
    const trialC = await sp.startCheckout(pool086, trialCo, trialP.purchaseId);

    // T-PRE-4 (on 086, before 087): an unknown trigger, then a drifted guard body.
    await setup086.query(`CREATE FUNCTION smoke_noop() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await setup086.query(`CREATE TRIGGER smoke_unknown_trg BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION smoke_noop()`);
    const pre4a = runPreflight(DB_086);
    await setup086.query(`DROP TRIGGER smoke_unknown_trg ON invoices`);
    const origAttempts = (await setup086.query(`SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname = 'payment_attempts_guard_mutation'`)).rows[0].d;
    await setup086.query(origAttempts.replace("'payment_attempts: new rows must start", "'payment_attempts (drifted): new rows must start"));
    const pre4b = runPreflight(DB_086);
    await setup086.query(origAttempts);
    const pre4c = runPreflight(DB_086);
    check('T-PRE-4: an unknown user trigger on invoices -> STOP; a drifted attempt-guard body -> STOP; restored -> pass',
      pre4a.code === 2 && pre4a.out.includes('unknown user trigger') && pre4b.code === 2 && pre4b.out.includes('guard function body drift') && pre4c.code === 0,
      [pre4a.code, pre4b.code, pre4c.code]);

    await setup086.query(fs.readFileSync(path.join(__dirname, 'MIGRATION_087_subscription_upgrade_foundation.sql'), 'utf8'));
    const pre3 = runPreflight(DB_086);
    check('T-PRE-3: after 087 the preflight STOPs (087 artifacts exist)', pre3.code === 2 && pre3.out.includes('MIGRATION_087 artifacts already exist'), pre3.out.slice(-300));
    const trialR = await resolveCheckoutSessionCore(pool086, trialC.sessionId, 'succeeded');
    const t2 = (await setup086.query(
      `SELECT c.plan, c.subscription_status, sp.status AS purchase_status, sp.replaces_subscription_id,
              (SELECT count(*)::int FROM subscriptions WHERE company_id = c.id AND status = 'superseded') AS superseded
       FROM companies c JOIN subscription_purchases sp ON sp.company_id = c.id WHERE c.id = $1`, [trialCo])).rows[0];
    check('T-REG-2: a B7 purchase opened before 087 settles under B8 code after 087 through the unchanged trial apply (replaces NULL, no superseded row)',
      trialR.kind === 'ok' && trialR.purchaseApplied && !trialR.purchaseApplied.superseded_subscription_id &&
      t2.plan === 'silver' && t2.subscription_status === 'active' && t2.purchase_status === 'completed' && t2.replaces_subscription_id === null && t2.superseded === 0, t2);

    // ======================================================================
    console.log('\n== I. T-COMPAT-4 — the accepted B7 code on schema 087 with real superseded rows ==');
    if (SKIP_LEGACY) {
      check('T-COMPAT-4 was SKIPPED by SMOKE_B8_SKIP_LEGACY=yes (not proven in this run)', false);
    } else {
      legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-b8-legacy-'));
      const repoRoot = path.resolve(__dirname, '..', '..');
      const tarball = execFileSync('git', ['-C', repoRoot, 'archive', '--format=tar', LEGACY_REF, 'backend/src', 'backend/tsconfig.json'], { maxBuffer: 256 * 1024 * 1024 });
      const tarPath = path.join(legacyDir, 'legacy.tar');
      fs.writeFileSync(tarPath, tarball);
      execFileSync('tar', ['-xf', tarPath, '-C', legacyDir]);
      // Resolve the legacy tree's bare imports (pg, express, …) from this
      // backend's node_modules, without writing anything into the repository.
      process.env.NODE_PATH = [path.resolve(__dirname, '..', 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
      require('module').Module._initPaths();
      const L = (rel) => require(path.join(legacyDir, 'backend', 'src', rel));
      const lsp = L('services/subscriptionPurchase');
      const { resolveCheckoutSessionCore: lresolve } = L('services/paymentSettlement');
      const ladmin = L('controllers/admin.controller');
      const lbilling = L('controllers/billing.controller');
      const lpool = L('db/pool').pool;
      extraPools.push(lpool);

      // A real superseded row exists (sections B/C created many).
      const supCount = (await q1(`SELECT count(*)::int AS n FROM subscriptions WHERE status = 'superseded'`)).n;
      const paidSup = (await q1(
        `SELECT c.id FROM companies c JOIN subscriptions s ON s.company_id = c.id AND s.status = 'superseded'
         WHERE c.subscription_status = 'active' LIMIT 1`)).id;
      const plansOut = await invoke(lbilling.getPlans, makeReq({}, {}, { userId: 'u', companyId: paidSup, role: 'admin' }));
      let paidCode;
      try {
        await lsp.confirmPurchase(lpool, { companyId: paidSup, plan: 'gold', interval: 'annual', currency: 'USD', amountText: catalogPriceText('gold', 'annual') });
      } catch (e) { paidCode = e.code; }
      const lt = await newCompany('legacy trial');
      const lp = await lsp.confirmPurchase(lpool, { companyId: lt, plan: 'bronze', interval: 'monthly', currency: 'USD', amountText: catalogPriceText('bronze', 'monthly') });
      const lc = await lsp.startCheckout(lpool, lt, lp.purchaseId);
      const lr = await lresolve(lpool, lc.sessionId, 'succeeded');
      const lts = await state(lt);
      // B7 admin guard on a company with an open B7 purchase.
      const lt2 = await newCompany('legacy guard');
      await lsp.confirmPurchase(lpool, { companyId: lt2, plan: 'silver', interval: 'monthly', currency: 'USD', amountText: catalogPriceText('silver', 'monthly') });
      const guard = await invoke(ladmin.updateCompany, makeReq({ id: lt2 }, { subscription_status: 'suspended' }));
      // A B7 success on an OPEN UPGRADE purchase: the trial assertion throws.
      const U = await makePaid('legacy vs upgrade', 'bronze', 'monthly');
      const uP = await upgrade(U.co, 'gold', 'monthly', U.src);
      const uC = await sp.startCheckout(pool, U.co, uP.purchaseId);
      const beforeU = await writeCounts();
      let threw = false;
      try { await lresolve(lpool, uC.sessionId, 'succeeded'); } catch (e) { threw = /not 'trial'/.test(String(e.message)); }
      const afterU = await writeCounts();
      const uS = await state(U.co);
      const b7PaymentDateTxn = (await q1(
        `SELECT i.payment_date = pa.succeeded_at AS same, i.payment_date <= pa.succeeded_at AS le FROM invoices i
         JOIN payment_attempts pa ON pa.invoice_id = i.id AND pa.status = 'succeeded' WHERE i.company_id = $1`, [lt]));
      check(`T-COMPAT-4: B7 /plans ignores superseded rows (paid company NOT_ELIGIBLE, ${supCount} superseded rows present) and B7 confirm on it -> NOT_ELIGIBLE`,
        supCount > 0 && plansOut.status === 200 && plansOut.body.purchase_block_reason === 'NOT_ELIGIBLE' && paidCode === 'NOT_ELIGIBLE', { paidCode, reason: plansOut.body && plansOut.body.purchase_block_reason });
      check('T-COMPAT-4: B7 trial confirm + checkout + settlement work on 087 (replaces NULL); B7 admin guard still returns 409 for an open purchase',
        lr.kind === 'ok' && lr.purchaseApplied && lts.company.plan === 'bronze' && lts.company.subscription_status === 'active' &&
        guard.status === 409 && guard.body.code === 'OPEN_CUSTOMER_PURCHASE');
      check('T-COMPAT-4: a B7 success on an open UPGRADE purchase throws (trial assertion) -> ROLLBACK, zero writes; the upgrade chain stays open',
        threw && JSON.stringify(beforeU) === JSON.stringify(afterU) && uS.purchases.find((x) => x.id === uP.purchaseId).status === 'open' &&
        uS.subs.find((x) => x.id === U.src).status === 'active');
      check('T-COMPAT-4 (documented): B7 code writes payment_date = now() (transaction start), so it can precede the trigger-stamped succeeded_at',
        b7PaymentDateTxn && b7PaymentDateTxn.le === true, b7PaymentDateTxn);
    }

    // ======================================================================
    console.log('\n== J. Deadlocks ==');
    const logDeadlocks = (await q1(`SELECT deadlocks FROM pg_stat_database WHERE datname = $1`, [DB_NAME])).deadlocks;
    check(`zero 40P01 deadlocks observed by the app (${deadlocks.length}) and by pg_stat_database (${logDeadlocks})`, deadlocks.length === 0 && Number(logDeadlocks) === 0, deadlocks);

    const failed = checks.filter(([, pass]) => !pass);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
    exitCode = failed.length === 0 ? 0 : 1;
  } catch (err) {
    console.error('SMOKE RUN ERROR:', err);
    exitCode = 1;
  } finally {
    if (appPool) await appPool.end().catch(() => {});
    for (const p of extraPools) await p.end().catch(() => {});
    for (const c of openClients) await c.end().catch(() => {});
    if (legacyDir) {
      try {
        fs.rmSync(legacyDir, { recursive: true, force: true });
      } catch (e) {
        console.error(`Could not remove the temporary legacy directory ${legacyDir}: ${e.message}`);
      }
    }
    const cleanup = new Client(clientConfig(parsedConfig.database));
    try {
      await cleanup.connect();
      for (const db of created) {
        await cleanup.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [db]);
        await cleanup.query(`DROP DATABASE IF EXISTS ${db}`);
        console.log(`Dropped disposable database ${db}.`);
      }
    } catch (e) {
      console.error(`CLEANUP FAILED: could not confirm the disposable databases were dropped (${e.message}). Check: ${created.join(', ')}`);
      exitCode = 1;
    } finally {
      await cleanup.end().catch(() => {});
    }
  }
  process.exit(exitCode);
}

main();
