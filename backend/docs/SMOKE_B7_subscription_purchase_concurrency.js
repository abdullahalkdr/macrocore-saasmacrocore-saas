/**
 * Standalone disposable-PostgreSQL proof for Stage B7 (Trial-to-Paid Customer
 * Self-Service Subscription Checkout — design pass v3, approved; see
 * claude/chat7a-b7-customer-subscription-checkout-design-pass-v3-2026-09-24.md
 * §12.2). Follows the safety/observability conventions of
 * SMOKE_B1/B3/B5/B6: explicit host validation with no default substitution,
 * SMOKE_CONFIRM_DISPOSABLE=yes required, one uniquely-named throwaway
 * database per run, every client closed before DROP DATABASE, a cleanup
 * failure fails the whole run, and zero 40P01 deadlocks asserted.
 *
 * Unlike SMOKE_B6 (minimal hand-built tables), this script builds the
 * disposable database by replaying the REAL repository schema history: the
 * root docs/DATABASE_SCHEMA.sql bootstrap, then every
 * backend/docs/MIGRATION_0NN_*.sql file in order through MIGRATION_085, then
 * the REAL MIGRATION_086 file — never a copied DDL block. B7 touches
 * companies/email_jobs/audit_logs as well as the billing tables, so the real
 * shapes matter.
 *
 * The application side is the REAL TypeScript code loaded through ts-node:
 * services/subscriptionPurchase.ts (confirmPurchase, startCheckout,
 * applyPurchaseOnTrustedSuccess via the settlement core),
 * services/paymentSettlement.ts (resolveCheckoutSessionCore), and the REAL
 * admin.controller.ts activateSubscription / updateCompany /
 * createSubscriptionInvoice handlers. db/pool.ts is pointed at the disposable
 * database by setting DATABASE_URL in this process BEFORE any app module is
 * loaded (this script never reads a .env file for it — dotenv does not
 * override an already-set variable).
 *
 * Run with (bash):
 *   SMOKE_CONCURRENCY_ADMIN_URL="postgres://pguser@127.0.0.1:55432/postgres" \
 *   SMOKE_CONFIRM_DISPOSABLE=yes \
 *     node docs/SMOKE_B7_subscription_purchase_concurrency.js
 *
 * Point ADMIN_URL at a local/dev Postgres server you control, never at
 * production. The role needs CREATEDB.
 */

const { Client, Pool } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RAW_ADMIN_URL = process.env.SMOKE_CONCURRENCY_ADMIN_URL;
const CONFIRM_DISPOSABLE = process.env.SMOKE_CONFIRM_DISPOSABLE;
const ITERATIONS = Number.parseInt(process.env.SMOKE_B7_ITERATIONS || '6', 10);

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
const DB_NAME = `smoke_b7_purchase_${RUN_ID}`;
const port = parsedConfig.port || 5432;
const userPart = parsedConfig.user ? `${encodeURIComponent(parsedConfig.user)}${parsedConfig.password ? `:${encodeURIComponent(parsedConfig.password)}` : ''}@` : '';
// Bounded lock/statement timeouts on EVERY app connection (never PostgreSQL's
// unbounded defaults), passed through the libpq `options` parameter.
const APP_DB_URL = `postgres://${userPart}${rawHost}:${port}/${DB_NAME}?options=${encodeURIComponent('-c lock_timeout=8000 -c statement_timeout=20000')}`;
console.log(`Target (redacted): postgres://${parsedConfig.user || '(default)'}:***@${rawHost}:${port}/${DB_NAME}`);

// App modules read DATABASE_URL at import time — point them at the disposable
// database BEFORE loading anything from src/.
process.env.DATABASE_URL = APP_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-only-jwt-secret-not-real';
process.env.ENABLE_BACKGROUND_SWEEPS = 'false';
process.env.RESEND_API_KEY = '';

function clientConfig(dbName) {
  return { ...parsedConfig, host: rawHost, database: dbName };
}

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
  const base = fs.readFileSync(path.join(repoRoot, 'docs', 'DATABASE_SCHEMA.sql'), 'utf8');
  await setup.query(base);
  const migrations = fs
    .readdirSync(__dirname)
    .filter((f) => /^MIGRATION_0\d\d_.*\.sql$/.test(f))
    .sort();
  let applied = 0;
  for (const file of migrations) {
    // Stage B8: 086 and every later migration are applied explicitly below,
    // in order — the glob must never apply MIGRATION_087 before 086.
    if (file >= 'MIGRATION_086') continue;
    await setup.query(fs.readFileSync(path.join(__dirname, file), 'utf8'));
    applied += 1;
  }
  console.log(`Replayed the bootstrap schema + ${applied} migration files (through MIGRATION_085).`);
  await setup.query(fs.readFileSync(path.join(__dirname, 'MIGRATION_086_subscription_purchase_foundation.sql'), 'utf8'));
  console.log('Applied the REAL MIGRATION_086_subscription_purchase_foundation.sql.');
  // Stage B8: the current settlement / purchase code reads
  // subscription_purchases.replaces_subscription_id, so this B7 regression
  // proof also applies the REAL MIGRATION_087. Every scenario here remains a
  // B7 trial-to-paid purchase (replaces_subscription_id IS NULL).
  await setup.query(fs.readFileSync(path.join(__dirname, 'MIGRATION_087_subscription_upgrade_foundation.sql'), 'utf8'));
  console.log('Applied the REAL MIGRATION_087_subscription_upgrade_foundation.sql.');
}

// A Connectable adapter over a dedicated pg Client that records the
// transaction's own now() right after BEGIN — used to prove a request that
// began BEFORE a deadline, then waited on a lock past it, is still decided on
// the real clock (clock_timestamp()), not its stale transaction start.
function recordingConnectable(client, record) {
  const query = async (sql, params) => {
    const res = await client.query(sql, params);
    if (sql === 'BEGIN') {
      record.txnNow = (await client.query('SELECT now() AS t, clock_timestamp() AS c')).rows[0];
      record.began = true;
    }
    return res;
  };
  return {
    query,
    connect: async () => ({ query, release: () => {} }),
  };
}

function makeReq(params, body) {
  return { params, body, headers: { 'user-agent': 'smoke-b7' }, ip: '127.0.0.1', auth: undefined };
}

// asyncHandler-wrapped controllers return void; resolve on res.json or next(err).
function invoke(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    handler(req, res, (err) => {
      noteIfDeadlock(err, 'controller');
      resolve({ status: err && err.statusCode ? err.statusCode : 500, error: err });
    });
  });
}

async function main() {
  const admin = new Client(clientConfig(parsedConfig.database));
  await admin.connect();
  let dbCreated = false;
  try {
    console.log(`PostgreSQL server: ${(await admin.query('SELECT version()')).rows[0].version}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    dbCreated = true;
  } finally {
    await admin.end();
  }

  const openClients = [];
  const track = (c) => { openClients.push(c); return c; };
  let appPool = null;
  let exitCode = 1;

  try {
    const setup = track(new Client(clientConfig(DB_NAME)));
    await setup.connect();
    await buildSchema(setup);
    // A deliberately non-UTC session zone for every setup statement: B7's
    // period arithmetic must not depend on it.
    await setup.query(`SET TIME ZONE 'Asia/Kuwait'`);

    // --- Load the REAL app code now that DATABASE_URL points here. -------
    require('ts-node/register/transpile-only');
    const sp = require('../src/services/subscriptionPurchase');
    const { resolveCheckoutSessionCore } = require('../src/services/paymentSettlement');
    const { addUtcMonths } = require('../src/utils/subscriptionLifecycle');
    const adminController = require('../src/controllers/admin.controller');
    const { pool } = require('../src/db/pool');
    appPool = pool;

    async function expectFail(sql, params, fragment) {
      try {
        await setup.query(sql, params);
        return false;
      } catch (err) {
        return !fragment || String(err.message).includes(fragment) || String(err.code).includes(fragment);
      }
    }
    async function newCompany(label, overrides = {}) {
      const r = await setup.query(
        `INSERT INTO companies (name, plan, subscription_status) VALUES ($1, $2, $3) RETURNING id`,
        [label, overrides.plan || 'trial', overrides.subscription_status || 'trial']
      );
      return r.rows[0].id;
    }
    const confirm = (companyId, plan = 'silver', interval = 'annual', db = pool) =>
      sp.confirmPurchase(db, {
        companyId,
        plan,
        interval,
        currency: 'USD',
        amountText: require('../src/config/planCatalog').catalogPriceText(plan, interval),
      });
    async function state(companyId) {
      const q = async (sql) => (await setup.query(sql, [companyId])).rows;
      return {
        company: (await q(`SELECT plan, subscription_status FROM companies WHERE id = $1`))[0],
        subs: await q(`SELECT id, status, plan FROM subscriptions WHERE company_id = $1 ORDER BY created_at`),
        invoices: await q(`SELECT id, status, payment_date FROM invoices WHERE company_id = $1`),
        purchases: await q(`SELECT id, status FROM subscription_purchases WHERE company_id = $1`),
        attempts: await q(`SELECT id, status FROM payment_attempts WHERE company_id = $1`),
        sessions: await q(`SELECT pcs.id, pcs.status FROM payment_checkout_sessions pcs JOIN payment_attempts pa ON pa.id = pcs.payment_attempt_id WHERE pa.company_id = $1`),
      };
    }
    const count = (rows, pred) => rows.filter(pred).length;

    // A fixture purchase with a SHORT window, built from the same shapes the
    // real confirm writes (the guard trigger allows any expires_at >
    // created_at on INSERT). Used only for deadline-boundary scenarios.
    async function shortWindowPurchase(companyId, windowMs, plan = 'silver') {
      await setup.query('BEGIN');
      const sub = (await setup.query(
        `WITH c AS (SELECT clock_timestamp() AS t)
         INSERT INTO subscriptions (company_id, plan, status, currency, period_amount, monthly_price, billing_interval,
                                    current_period_start, current_period_end, auto_renew, next_billing_date)
         SELECT $1, $2, 'pending_payment', 'USD', 39.000, 39.000, 'monthly', c.t,
                ((c.t AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC', false,
                ((c.t AT TIME ZONE 'UTC') + interval '1 month') FROM c RETURNING id`,
        [companyId, plan]
      )).rows[0];
      const inv = (await setup.query(
        `INSERT INTO invoices (company_id, subscription_id, plan, billing_interval, currency, amount, period_start, period_end, status, issue_date, due_date)
         SELECT company_id, id, plan, billing_interval, currency, period_amount, current_period_start, current_period_end, 'issued', current_period_start, current_period_start
         FROM subscriptions WHERE id = $1 RETURNING id`,
        [sub.id]
      )).rows[0];
      const pur = (await setup.query(
        `INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, created_at, expires_at)
         SELECT company_id, id, $2, current_period_start, clock_timestamp() + make_interval(secs => $3::double precision / 1000)
         FROM subscriptions WHERE id = $1 RETURNING id, expires_at`,
        [sub.id, inv.id, windowMs]
      )).rows[0];
      await setup.query('COMMIT');
      return { purchaseId: pur.id, expiresAt: new Date(pur.expires_at), subId: sub.id, invoiceId: inv.id };
    }

    // ======================================================================
    console.log('\n== A. Schema proofs (real MIGRATION_086 constraints + triggers) ==');
    const coA = await newCompany('schema proofs');
    const subCols = `company_id, plan, currency, billing_interval, current_period_start, current_period_end, period_amount`;
    const subVals = `$1, 'bronze', 'USD', 'monthly', now(), now() + interval '1 month', 32`;
    check('subscriptions: INSERT with status NULL fails (NOT NULL)', await expectFail(`INSERT INTO subscriptions (status, ${subCols}) VALUES (NULL, ${subVals})`, [coA], '23502'));
    check("subscriptions: INSERT with status 'foo' fails (CHECK)", await expectFail(`INSERT INTO subscriptions (status, ${subCols}) VALUES ('foo', ${subVals})`, [coA], 'subscriptions_status_valid'));
    check("subscriptions: INSERT as 'abandoned' fails (guard)", await expectFail(`INSERT INTO subscriptions (status, ${subCols}) VALUES ('abandoned', ${subVals})`, [coA], 'cannot be created as abandoned'));
    const activeSub = (await setup.query(`INSERT INTO subscriptions (status, ${subCols}) VALUES ('cancelled', ${subVals}) RETURNING id`, [coA])).rows[0].id;
    check("subscriptions: cancelled -> pending_payment fails", await expectFail(`UPDATE subscriptions SET status = 'pending_payment' WHERE id = $1`, [activeSub], 'cannot transition into pending_payment'));
    check("subscriptions: cancelled -> abandoned fails", await expectFail(`UPDATE subscriptions SET status = 'abandoned' WHERE id = $1`, [activeSub], 'only pending_payment may become abandoned'));
    const pendingSub = (await setup.query(`INSERT INTO subscriptions (status, ${subCols}) VALUES ('pending_payment', ${subVals}) RETURNING id`, [coA])).rows[0].id;
    check("subscriptions: pending_payment -> cancelled fails", await expectFail(`UPDATE subscriptions SET status = 'cancelled' WHERE id = $1`, [pendingSub], 'not permitted'));
    const protectedCols = {
      id: 'gen_random_uuid()', company_id: `(SELECT id FROM companies WHERE id <> '${coA}' LIMIT 1)`, plan: `'gold'`,
      monthly_price: '1', auto_renew: 'NOT COALESCE(auto_renew, false)', next_billing_date: `now()::timestamp`,
      created_at: `now()::timestamp - interval '1 day'`, updated_at: `now()::timestamp - interval '1 day'`, currency: `'KWD'`,
      billing_interval: `'annual'`, current_period_start: `now() - interval '1 day'`, current_period_end: `now() + interval '2 months'`,
      period_amount: '33',
    };
    let pendingMutationsBlocked = 0;
    for (const [col, expr] of Object.entries(protectedCols)) {
      if (await expectFail(`UPDATE subscriptions SET ${col} = ${expr} WHERE id = $1`, [pendingSub], 'immutable except status')) pendingMutationsBlocked += 1;
      else console.log(`    (pending) column ${col} was mutable!`);
    }
    check(`subscriptions: every protected column (${Object.keys(protectedCols).length}) is immutable on a pending_payment row`, pendingMutationsBlocked === Object.keys(protectedCols).length);
    check("subscriptions: pending_payment -> active + another column fails", await expectFail(`UPDATE subscriptions SET status = 'active', plan = 'gold' WHERE id = $1`, [pendingSub], 'immutable except status'));
    await setup.query(`UPDATE subscriptions SET status = 'abandoned' WHERE id = $1`, [pendingSub]);
    check('subscriptions: pending_payment -> abandoned (status only) succeeds', true);
    let abandonedBlocked = 0;
    for (const [col, expr] of Object.entries(protectedCols)) {
      if (await expectFail(`UPDATE subscriptions SET ${col} = ${expr} WHERE id = $1`, [pendingSub])) abandonedBlocked += 1;
    }
    check(`subscriptions: every protected column is immutable on an abandoned row`, abandonedBlocked === Object.keys(protectedCols).length);
    check("subscriptions: abandoned -> active fails (terminal)", await expectFail(`UPDATE subscriptions SET status = 'active' WHERE id = $1`, [pendingSub], 'terminal'));
    const pendingSub2 = (await setup.query(`INSERT INTO subscriptions (status, ${subCols}) VALUES ('pending_payment', ${subVals}) RETURNING id`, [coA])).rows[0].id;
    await setup.query(`UPDATE subscriptions SET status = 'active' WHERE id = $1`, [pendingSub2]);
    check('subscriptions: pending_payment -> active changing ONLY status succeeds', true);
    await setup.query(`UPDATE subscriptions SET status = 'cancelled' WHERE id = $1`, [pendingSub2]);
    check('subscriptions: an ordinary active -> cancelled update is untouched by the guard', true);

    // invoices transitions
    const coInv = await newCompany('invoice transitions');
    const s1 = (await setup.query(`INSERT INTO subscriptions (status, ${subCols}) VALUES ('pending_payment', ${subVals}) RETURNING id`, [coInv])).rows[0].id;
    const mkInv = async (subId) => (await setup.query(
      `INSERT INTO invoices (company_id, subscription_id, plan, billing_interval, currency, amount, period_start, period_end, status, issue_date, due_date)
       SELECT company_id, id, plan, billing_interval, currency, period_amount, current_period_start + (random() * interval '1 day'), current_period_end, 'issued', now(), now()
       FROM subscriptions WHERE id = $1 RETURNING id`, [subId])).rows[0].id;
    const invA = await mkInv(s1);
    const invB = await mkInv(s1);
    await setup.query(`UPDATE invoices SET status = 'paid', payment_date = now() WHERE id = $1`, [invA]);
    check("invoices: issued -> paid OK; paid -> void fails", await expectFail(`UPDATE invoices SET status = 'void', payment_date = NULL WHERE id = $1`, [invA], 'not permitted'));
    check("invoices: paid -> issued fails", await expectFail(`UPDATE invoices SET status = 'issued', payment_date = NULL WHERE id = $1`, [invA], 'not permitted'));
    await setup.query(`UPDATE invoices SET status = 'void' WHERE id = $1`, [invB]);
    check("invoices: issued -> void OK; void -> issued fails", await expectFail(`UPDATE invoices SET status = 'issued' WHERE id = $1`, [invB], 'not permitted'));
    check("invoices: void -> paid fails", await expectFail(`UPDATE invoices SET status = 'paid', payment_date = now() WHERE id = $1`, [invB], 'not permitted'));
    const invC = await mkInv(s1);
    check("invoices: void with a payment_date fails (085 consistency CHECK)", await expectFail(`UPDATE invoices SET status = 'void', payment_date = now() WHERE id = $1`, [invC], 'invoices_payment_date_consistency'));

    // purchases
    const coP = await newCompany('purchase guard');
    const sP = (await setup.query(`INSERT INTO subscriptions (status, ${subCols}) VALUES ('pending_payment', ${subVals}) RETURNING id`, [coP])).rows[0].id;
    const iP = await mkInv(sP);
    check("purchases: INSERT as non-open fails", await expectFail(
      `INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, status, expires_at) VALUES ($1, $2, $3, 'completed', now() + interval '30 minutes')`, [coP, sP, iP], 'must start open'));
    const pRow = (await setup.query(
      `INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, expires_at) VALUES ($1, $2, $3, now() + interval '30 minutes') RETURNING id`, [coP, sP, iP])).rows[0].id;
    check('purchases: DELETE fails (append-only)', await expectFail(`DELETE FROM subscription_purchases WHERE id = $1`, [pRow], 'append-only'));
    let purchaseImmutable = 0;
    const purchaseCols = { company_id: `(SELECT id FROM companies WHERE id <> '${coP}' LIMIT 1)`, subscription_id: 'gen_random_uuid()', invoice_id: 'gen_random_uuid()', created_at: `now() - interval '1 hour'`, expires_at: `now() + interval '1 day'`, id: 'gen_random_uuid()' };
    for (const [col, expr] of Object.entries(purchaseCols)) {
      if (await expectFail(`UPDATE subscription_purchases SET ${col} = ${expr} WHERE id = $1`, [pRow])) purchaseImmutable += 1;
    }
    check('purchases: every identity/link/time column is immutable', purchaseImmutable === Object.keys(purchaseCols).length);
    const sP2 = (await setup.query(`INSERT INTO subscriptions (status, ${subCols}) VALUES ('pending_payment', ${subVals}) RETURNING id`, [coP])).rows[0].id;
    const iP2 = await mkInv(sP2);
    check('purchases: a second OPEN purchase per company fails (partial unique index)', await expectFail(
      `INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, expires_at) VALUES ($1, $2, $3, now() + interval '30 minutes')`, [coP, sP2, iP2], 'subscription_purchases_one_open_per_company'));
    const stamped = (await setup.query(`UPDATE subscription_purchases SET status = 'completed' WHERE id = $1 RETURNING completed_at, voided_at`, [pRow])).rows[0];
    check('purchases: open -> completed stamps completed_at (trigger-owned)', stamped.completed_at && !stamped.voided_at);
    check('purchases: completed -> void fails', await expectFail(`UPDATE subscription_purchases SET status = 'void' WHERE id = $1`, [pRow], 'not permitted'));
    const pV = (await setup.query(
      `INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, expires_at) VALUES ($1, $2, $3, now() + interval '30 minutes') RETURNING id`, [coP, sP2, iP2])).rows[0].id;
    const stampedV = (await setup.query(`UPDATE subscription_purchases SET status = 'void' WHERE id = $1 RETURNING completed_at, voided_at`, [pV])).rows[0];
    check('purchases: open -> void stamps voided_at', stampedV.voided_at && !stampedV.completed_at);
    const coOther = await newCompany('other tenant');
    const sOther = (await setup.query(`INSERT INTO subscriptions (status, ${subCols}) VALUES ('pending_payment', ${subVals}) RETURNING id`, [coOther])).rows[0].id;
    const iOther = await mkInv(sOther);
    check("purchases: another company's invoice/subscription is rejected by the composite FKs", await expectFail(
      `INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, expires_at) VALUES ($1, $2, $3, now() + interval '30 minutes')`, [coP, sOther, iOther], '23503'));
    check('purchases: expires_at must be after created_at', await expectFail(
      `INSERT INTO subscription_purchases (company_id, subscription_id, invoice_id, created_at, expires_at) VALUES ($1, $2, $3, now(), now())`, [coOther, sOther, iOther], 'subscription_purchases_expiry_after_create'));
    check('RESTRICT: deleting a company with a purchase fails', await expectFail(`DELETE FROM companies WHERE id = $1`, [coP], '23503'));
    check('RESTRICT: deleting a pending subscription referenced by a purchase fails', await expectFail(`DELETE FROM subscriptions WHERE id = $1`, [sP], '23503'));
    check('RESTRICT: deleting an invoice referenced by a purchase fails', await expectFail(`DELETE FROM invoices WHERE id = $1`, [iP], '23503'));

    // ======================================================================
    console.log('\n== B. Period arithmetic: SQL (UTC) == B2 addUtcMonths on edge dates ==');
    const edges = ['2027-01-31T10:15:30.123Z', '2028-02-29T23:59:59.999Z', '2027-03-31T00:00:00.000Z', '2026-12-31T21:30:00.000Z', '2027-05-31T23:59:59.000Z'];
    let periodOk = true;
    for (const t of edges) {
      for (const [interval, months] of [['1 month', 1], ['12 months', 12]]) {
        const r = (await setup.query(`SELECT ((($1::timestamptz) AT TIME ZONE 'UTC') + $2::interval) AT TIME ZONE 'UTC' AS e`, [t, interval])).rows[0].e;
        const expected = addUtcMonths(new Date(t), months);
        if (new Date(r).getTime() !== expected.getTime()) {
          periodOk = false;
          console.log(`    mismatch ${t} + ${interval}: sql=${new Date(r).toISOString()} js=${expected.toISOString()}`);
        }
      }
    }
    check('SQL period end equals addUtcMonths for Jan 31, Feb 29, Mar 31, Dec 31 and end-of-day, monthly+annual (session zone Asia/Kuwait)', periodOk);

    // ======================================================================
    console.log('\n== C. Confirmation clock (R1) ==');
    const coC = await newCompany('clock proof');
    const created = await confirm(coC, 'silver', 'annual');
    const eq = (await setup.query(
      `SELECT s.current_period_start = i.issue_date AS a, i.issue_date = i.due_date AS b, i.period_start = s.current_period_start AS c,
              p.created_at = s.current_period_start AS d, (p.expires_at - p.created_at) = interval '30 minutes' AS e,
              s.period_amount::text AS sub_amount, i.amount::text AS inv_amount, s.monthly_price::text AS monthly,
              s.current_period_end = ((s.current_period_start AT TIME ZONE 'UTC') + interval '12 months') AT TIME ZONE 'UTC' AS f
       FROM subscription_purchases p JOIN subscriptions s ON s.id = p.subscription_id JOIN invoices i ON i.id = p.invoice_id WHERE p.id = $1`,
      [created.purchaseId]
    )).rows[0];
    check('pending.current_period_start = invoice.issue_date = invoice.due_date = invoice.period_start = purchase.created_at (microsecond-equal)', eq.a && eq.b && eq.c && eq.d);
    check('purchase.expires_at - created_at = 30 minutes; period end = start + 12 months (UTC)', eq.e && eq.f);
    check('money: pending subscription and invoice amount are exactly "384.000"; monthly_price "32.000"', eq.sub_amount === '384.000' && eq.inv_amount === '384.000' && eq.monthly === '32.000', eq);
    check('confirmation changes nothing live: company still trial, no active subscription', (await state(coC)).company.subscription_status === 'trial' && count((await state(coC)).subs, (s) => s.status === 'active') === 0);

    // A confirm that waits on the company lock anchors AFTER the wait.
    const coC2 = await newCompany('clock lock-wait');
    const holder = track(new Client(clientConfig(DB_NAME)));
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [coC2]);
    const waiter = track(new Client(clientConfig(DB_NAME)));
    await waiter.connect();
    await waiter.query(`SET lock_timeout = '10s'`);
    const rec = {};
    const confirmP = confirm(coC2, 'bronze', 'monthly', recordingConnectable(waiter, rec));
    await sleep(3000);
    const releasedAt = (await holder.query('SELECT clock_timestamp() AS t')).rows[0].t;
    await holder.query('COMMIT');
    const waited = await confirmP;
    const anchor = (await setup.query(`SELECT current_period_start FROM subscriptions WHERE id = $1`, [waited.subscriptionId])).rows[0].current_period_start;
    check('a confirm that waited on the company lock anchors confirmed_at AFTER the wait (> its own transaction now(), >= lock release)',
      new Date(anchor) > new Date(rec.txnNow.t) && new Date(anchor) >= new Date(releasedAt),
      { txnNow: rec.txnNow && rec.txnNow.t, releasedAt, anchor });

    // ======================================================================
    console.log('\n== D. Concurrency ==');
    // D1: 20 parallel same-plan confirms
    const coD1 = await newCompany('parallel same-plan');
    const d1 = await Promise.allSettled(Array.from({ length: 20 }, () => confirm(coD1, 'gold', 'monthly')));
    d1.forEach((r) => r.status === 'rejected' && noteIfDeadlock(r.reason, 'D1'));
    const sD1 = await state(coD1);
    check('20 parallel same-plan confirms -> exactly 1 purchase, 1 invoice, 1 pending subscription; 1 created + 19 replays',
      sD1.purchases.length === 1 && sD1.invoices.length === 1 && sD1.subs.length === 1 &&
      d1.filter((r) => r.status === 'fulfilled' && r.value.kind === 'created').length === 1 &&
      d1.filter((r) => r.status === 'fulfilled' && r.value.kind === 'replayed').length === 19,
      { purchases: sD1.purchases.length, rejected: d1.filter((r) => r.status === 'rejected').map((r) => r.reason.message) });

    // D2: parallel different-plan confirms
    const coD2 = await newCompany('parallel switch');
    const d2 = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => confirm(coD2, i % 2 ? 'gold' : 'bronze', i % 3 ? 'monthly' : 'annual')));
    d2.forEach((r) => r.status === 'rejected' && noteIfDeadlock(r.reason, 'D2'));
    const sD2 = await state(coD2);
    check('parallel different-plan confirms -> exactly 1 open purchase, every other purchase void, 1 issued invoice, 1 pending sub, no orphans',
      count(sD2.purchases, (p) => p.status === 'open') === 1 &&
      count(sD2.purchases, (p) => p.status === 'void') === sD2.purchases.length - 1 &&
      count(sD2.invoices, (i) => i.status === 'issued') === 1 &&
      count(sD2.invoices, (i) => i.status === 'void') === sD2.invoices.length - 1 &&
      count(sD2.subs, (s) => s.status === 'pending_payment') === 1 &&
      d2.every((r) => r.status === 'fulfilled'),
      { purchases: sD2.purchases, rejected: d2.filter((r) => r.status === 'rejected').map((r) => r.reason.message) });

    // D3: parallel checkouts
    const coD3 = await newCompany('parallel checkout');
    const pD3 = await confirm(coD3, 'silver', 'monthly');
    const d3 = await Promise.allSettled(Array.from({ length: 10 }, () => sp.startCheckout(pool, coD3, pD3.purchaseId)));
    d3.forEach((r) => r.status === 'rejected' && noteIfDeadlock(r.reason, 'D3'));
    const sD3 = await state(coD3);
    const sessionIds = new Set(d3.filter((r) => r.status === 'fulfilled').map((r) => r.value.sessionId));
    check('10 parallel checkouts -> 1 initiated attempt, 1 pending session, every caller got the same session',
      sD3.attempts.length === 1 && sD3.attempts[0].status === 'initiated' && sD3.sessions.length === 1 && sessionIds.size === 1 && d3.every((r) => r.status === 'fulfilled'),
      { attempts: sD3.attempts, sessions: sD3.sessions });

    // D4: parallel success resolves
    const sessionD4 = [...sessionIds][0];
    const d4 = await Promise.allSettled(Array.from({ length: 10 }, () => resolveCheckoutSessionCore(pool, sessionD4, 'succeeded')));
    d4.forEach((r) => r.status === 'rejected' && noteIfDeadlock(r.reason, 'D4'));
    const sD4 = await state(coD3);
    check('10 parallel success resolves -> exactly 1 apply (1 ok + 9 conflicts), 1 active subscription, company active on silver, invoice paid, purchase completed',
      d4.filter((r) => r.status === 'fulfilled' && r.value.kind === 'ok' && r.value.purchaseApplied).length === 1 &&
      d4.filter((r) => r.status === 'fulfilled' && r.value.kind === 'conflict').length === 9 &&
      count(sD4.subs, (s) => s.status === 'active') === 1 && sD4.company.plan === 'silver' && sD4.company.subscription_status === 'active' &&
      sD4.invoices[0].status === 'paid' && sD4.purchases[0].status === 'completed',
      { company: sD4.company, subs: sD4.subs, purchases: sD4.purchases });
    const money = (await setup.query(
      `SELECT s.period_amount::text AS s, i.amount::text AS i, pa.amount::text AS a FROM subscriptions s
       JOIN invoices i ON i.subscription_id = s.id JOIN payment_attempts pa ON pa.invoice_id = i.id WHERE s.company_id = $1`, [coD3])).rows[0];
    check('money: amount::text identical across subscription, invoice and attempt ("39.000")', money.s === '39.000' && money.i === '39.000' && money.a === '39.000', money);
    const replayAfter = await resolveCheckoutSessionCore(pool, sessionD4, 'succeeded');
    check('settlement replay after apply -> conflict, no second activation', replayAfter.kind === 'conflict' && count((await state(coD3)).subs, (s) => s.status === 'active') === 1);
    const emailsD4 = (await setup.query(`SELECT count(*)::int AS n FROM email_jobs WHERE company_id = $1`, [coD3])).rows[0].n;
    check('no email was enqueued by confirm / checkout / self-service settlement', emailsD4 === 0, emailsD4);

    // D5: resolve vs confirm-switch
    let d5ok = true;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const co = await newCompany(`resolve-vs-switch ${i}`);
      const p = await confirm(co, 'silver', 'monthly');
      const c = await sp.startCheckout(pool, co, p.purchaseId);
      const [res, sw] = await Promise.allSettled(
        i % 2 ? [resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded'), confirm(co, 'gold', 'annual')]
              : [sleep(5).then(() => resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded')), confirm(co, 'gold', 'annual')]
      );
      [res, sw].forEach((r) => r.status === 'rejected' && noteIfDeadlock(r.reason, 'D5'));
      const s = await state(co);
      const applied = s.company.subscription_status === 'active' && count(s.subs, (x) => x.status === 'active') === 1 && s.purchases.some((x) => x.id === p.purchaseId && x.status === 'completed');
      const voided = s.company.subscription_status === 'trial' && s.purchases.some((x) => x.id === p.purchaseId && x.status === 'void') && s.sessions.some((x) => x.id === c.sessionId && x.status === 'cancelled');
      if (applied === voided) { d5ok = false; console.log('    D5 incoherent', JSON.stringify(s)); }
      // Stage B8 (design v4 §6.2 / §11 C3a): once the trial purchase applied,
      // the company is 'active' (upgrade mode), and a trial-shaped confirm
      // without expected_source_subscription_id is rejected as
      // UPGRADE_CONTEXT_STALE with zero writes (was NOT_ELIGIBLE in B7).
      if (applied && !(sw.status === 'rejected' && sw.reason.code === 'UPGRADE_CONTEXT_STALE')) { d5ok = false; console.log('    D5 switch should be UPGRADE_CONTEXT_STALE after apply'); }
      if (voided && !(res.status === 'fulfilled' && res.value.kind === 'conflict')) { d5ok = false; console.log('    D5 resolve should conflict after void'); }
      if (count(s.invoices, (x) => x.status === 'paid') > 1) d5ok = false;
    }
    check(`resolve('succeeded') vs confirm-switch (${ITERATIONS} iterations): applied XOR voided, never both`, d5ok);

    // D6: admin activation vs confirm
    let d6ok = true;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const co = await newCompany(`activation-vs-confirm ${i}`);
      const [act, con] = await Promise.all([
        invoke(adminController.activateSubscription, makeReq({ id: co }, { plan: 'gold', billing_interval: 'monthly', currency: 'USD', period_amount: 67 })),
        confirm(co, 'silver', 'monthly').then((v) => ({ ok: v }), (e) => ({ err: e })),
      ]);
      const s = await state(co);
      // Stage B8: after activation the company is in upgrade mode, so the
      // trial-shaped confirm (no source assertion) gets UPGRADE_CONTEXT_STALE.
      const activationWon = act.status === 201 && con.err && con.err.code === 'UPGRADE_CONTEXT_STALE' && count(s.purchases, () => true) === 0;
      const confirmWon = act.status === 409 && act.body && act.body.code === 'OPEN_CUSTOMER_PURCHASE' && con.ok && con.ok.kind === 'created' && s.company.subscription_status === 'trial';
      if (!(activationWon || confirmWon)) { d6ok = false; console.log('    D6 incoherent', act.status, act.body && act.body.code, con.err && con.err.code); }
    }
    check(`admin activation vs customer confirm (${ITERATIONS} iterations): exactly one wins, the other gets 409 / UPGRADE_CONTEXT_STALE (B8: was NOT_ELIGIBLE)`, d6ok);

    // D7: admin activation vs simulated success (unexpired purchase)
    let d7ok = true;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const co = await newCompany(`activation-vs-success ${i}`);
      const p = await confirm(co, 'silver', 'monthly');
      const c = await sp.startCheckout(pool, co, p.purchaseId);
      const [act, res] = await Promise.all([
        invoke(adminController.activateSubscription, makeReq({ id: co }, { plan: 'gold', billing_interval: 'monthly', currency: 'USD', period_amount: 67 })),
        resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded').catch((e) => ({ kind: 'error', e })),
      ]);
      const s = await state(co);
      const paidUnapplied = s.invoices.some((x) => x.status === 'paid') && s.company.subscription_status !== 'active';
      const coherent = res.kind === 'ok' && res.purchaseApplied && act.status === 409 && count(s.subs, (x) => x.status === 'active') === 1 && s.company.plan === 'silver';
      if (paidUnapplied || !coherent) { d7ok = false; console.log('    D7', act.status, act.body && act.body.code, res.kind); }
    }
    check(`admin activation vs simulated success on an unexpired purchase (${ITERATIONS} iterations): success applies, activation gets 409, never paid-but-unapplied`, d7ok);

    // D8: updateCompany vs open purchases
    const coD8 = await newCompany('update-vs-open');
    await confirm(coD8, 'bronze', 'monthly');
    const upd = await invoke(adminController.updateCompany, makeReq({ id: coD8 }, { subscription_status: 'suspended' }));
    check('updateCompany suspend vs an UNEXPIRED open purchase -> 409 OPEN_CUSTOMER_PURCHASE, company unchanged',
      upd.status === 409 && upd.body.code === 'OPEN_CUSTOMER_PURCHASE' && (await state(coD8)).company.subscription_status === 'trial');
    const coD8b = await newCompany('update-vs-expired');
    const fx8 = await shortWindowPurchase(coD8b, 300);
    await sleep(700);
    const upd2 = await invoke(adminController.updateCompany, makeReq({ id: coD8b }, { subscription_status: 'suspended' }));
    const s8 = await state(coD8b);
    const voidAudit = (await setup.query(
      `SELECT new_values FROM audit_logs WHERE company_id = $1 AND action = 'subscription_purchase_voided'`, [coD8b])).rows;
    check('updateCompany suspend vs an EXPIRED open purchase -> void (expired_admin_action) + suspend in one commit, void audit written',
      upd2.status === 200 && s8.company.subscription_status === 'suspended' && s8.purchases[0].status === 'void' &&
      s8.invoices[0].status === 'void' && s8.subs[0].status === 'abandoned' &&
      voidAudit.length === 1 && voidAudit[0].new_values.reason === 'expired_admin_action' && voidAudit[0].new_values.admin_action === 'update_company',
      { upd2: upd2.status, s8, voidAudit });

    // ======================================================================
    console.log('\n== E. Expiry boundary (simple) ==');
    const coE = await newCompany('expiry simple');
    const fxE = await shortWindowPurchase(coE, 2500);
    const cE = await sp.startCheckout(pool, coE, fxE.purchaseId);
    const coE2 = await newCompany('expiry simple 2');
    const fxE2 = await shortWindowPurchase(coE2, 1500);
    const cE2 = await sp.startCheckout(pool, coE2, fxE2.purchaseId);
    const okBefore = await resolveCheckoutSessionCore(pool, cE.sessionId, 'succeeded');
    check('success BEFORE the deadline -> applied', okBefore.kind === 'ok' && !!okBefore.purchaseApplied);
    await sleep(Math.max(0, fxE2.expiresAt.getTime() - Date.now()) + 500);
    const lateSuccess = await resolveCheckoutSessionCore(pool, cE2.sessionId, 'succeeded');
    const sE2 = await state(coE2);
    check('success AFTER the deadline -> 409 SESSION_EXPIRED, zero writes (session still pending, invoice issued, company trial)',
      lateSuccess.kind === 'conflict' && lateSuccess.code === 'SESSION_EXPIRED' && sE2.sessions[0].status === 'pending' &&
      sE2.invoices[0].status === 'issued' && sE2.company.subscription_status === 'trial', { lateSuccess, sE2 });
    let checkoutAfter;
    try { await sp.startCheckout(pool, coE2, fxE2.purchaseId); checkoutAfter = 'no error'; } catch (e) { checkoutAfter = e.code; }
    check('checkout AFTER the deadline -> PURCHASE_EXPIRED', checkoutAfter === 'PURCHASE_EXPIRED', checkoutAfter);
    const lateCancel = await resolveCheckoutSessionCore(pool, cE2.sessionId, 'cancelled');
    check('cancelled AFTER the deadline is still accepted (no deadline check for non-success outcomes); subscription untouched',
      lateCancel.kind === 'ok' && (await state(coE2)).company.subscription_status === 'trial');
    const reconfirm = await confirm(coE2, 'silver', 'monthly');
    const sE2b = await state(coE2);
    check('re-confirming after expiry voids the expired intent (expired_superseded) and creates a fresh one',
      reconfirm.kind === 'created' && reconfirm.voided && reconfirm.voided.reason === 'expired_superseded' &&
      count(sE2b.purchases, (p) => p.status === 'open') === 1 && count(sE2b.invoices, (x) => x.status === 'void') === 1);

    // ======================================================================
    console.log('\n== F. Lock-wait expiry (R1): began before the deadline, decided after it ==');
    async function lockWaitScenario(label, windowMs, runB) {
      const co = await newCompany(`lock-wait ${label}`);
      const fx = await shortWindowPurchase(co, windowMs);
      const c = await sp.startCheckout(pool, co, fx.purchaseId);
      const a = track(new Client(clientConfig(DB_NAME)));
      await a.connect();
      await a.query('BEGIN');
      await a.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [co]);
      const b = track(new Client(clientConfig(DB_NAME)));
      await b.connect();
      await b.query(`SET lock_timeout = '15s'`);
      const rec = {};
      const startedAt = Date.now();
      const pB = runB({ co, fx, c, db: recordingConnectable(b, rec) }).then((v) => ({ v }), (e) => ({ e }));
      await sleep(Math.max(0, fx.expiresAt.getTime() - Date.now()) + 700);
      await a.query('COMMIT');
      const out = await pB;
      await a.end();
      await b.end();
      return { co, fx, c, rec, startedAt, out };
    }
    const fR = await lockWaitScenario('resolve', 1500, ({ c, db }) => resolveCheckoutSessionCore(db, c.sessionId, 'succeeded'));
    check('resolve that began before the deadline and waited on the lock past it -> SESSION_EXPIRED (its txn now() was before expires_at)',
      fR.out.v && fR.out.v.kind === 'conflict' && fR.out.v.code === 'SESSION_EXPIRED' && new Date(fR.rec.txnNow.t) < fR.fx.expiresAt &&
      (await state(fR.co)).company.subscription_status === 'trial', { out: fR.out, txnNow: fR.rec.txnNow, expiresAt: fR.fx.expiresAt });
    const fC = await lockWaitScenario('checkout', 1500, ({ co, fx, db }) => sp.startCheckout(db, co, fx.purchaseId));
    check('checkout that began before the deadline and waited past it -> PURCHASE_EXPIRED, zero writes',
      fC.out.e && fC.out.e.code === 'PURCHASE_EXPIRED' && new Date(fC.rec.txnNow.t) < fC.fx.expiresAt, { out: fC.out.e && fC.out.e.code });
    const fP = await lockWaitScenario('confirm replay', 1500, ({ co, db }) => confirm(co, 'silver', 'monthly', db));
    check('same-plan confirm that began before the deadline and waited past it -> voids (expired_superseded) and re-creates instead of replaying',
      fP.out.v && fP.out.v.kind === 'created' && fP.out.v.voided && fP.out.v.voided.reason === 'expired_superseded' && new Date(fP.rec.txnNow.t) < fP.fx.expiresAt,
      { out: fP.out });
    // Admin activation through the REAL controller (global pool): it is
    // started before the deadline and blocks on the company lock inside its
    // own transaction.
    const coFA = await newCompany('lock-wait admin');
    const fxFA = await shortWindowPurchase(coFA, 1500);
    await sp.startCheckout(pool, coFA, fxFA.purchaseId);
    const aFA = track(new Client(clientConfig(DB_NAME)));
    await aFA.connect();
    await aFA.query('BEGIN');
    await aFA.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [coFA]);
    const startedBefore = Date.now() < fxFA.expiresAt.getTime();
    const pFA = invoke(adminController.activateSubscription, makeReq({ id: coFA }, { plan: 'gold', billing_interval: 'monthly', currency: 'USD', period_amount: 67 }));
    await sleep(Math.max(0, fxFA.expiresAt.getTime() - Date.now()) + 700);
    await aFA.query('COMMIT');
    const outFA = await pFA;
    await aFA.end();
    const sFA = await state(coFA);
    check('admin activation that began before the deadline and waited past it -> voids (expired_admin_action) and activates, one commit',
      startedBefore && outFA.status === 201 && sFA.company.subscription_status === 'active' && sFA.purchases[0].status === 'void' &&
      sFA.invoices.some((x) => x.status === 'void') && sFA.sessions[0].status === 'cancelled', { outFA: outFA.status, sFA });

    // ======================================================================
    console.log('\n== G. Admin cleanup vs simulator success around the deadline (R2) ==');
    let gOk = true;
    let gA = 0;
    let gB = 0;
    for (let i = 0; i < ITERATIONS * 2; i += 1) {
      const co = await newCompany(`boundary ${i}`);
      const fx = await shortWindowPurchase(co, 400);
      const c = await sp.startCheckout(pool, co, fx.purchaseId);
      await sleep(Math.max(0, fx.expiresAt.getTime() - Date.now()) - 15 + (i % 3) * 15);
      const useUpdate = i % 2 === 1;
      const adminCall = useUpdate
        ? invoke(adminController.updateCompany, makeReq({ id: co }, { subscription_status: 'suspended' }))
        : invoke(adminController.activateSubscription, makeReq({ id: co }, { plan: 'gold', billing_interval: 'monthly', currency: 'USD', period_amount: 67 }));
      const [adm, res] = await Promise.all(
        i % 4 < 2 ? [adminCall, resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded').catch((e) => ({ kind: 'error', e }))]
                  : [sleep(3).then(() => adminCall), resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded').catch((e) => ({ kind: 'error', e }))]
      );
      if (res.kind === 'error') noteIfDeadlock(res.e, 'G');
      const s = await state(co);
      const purchase = s.purchases[0];
      const outcomeA = purchase.status === 'completed' && s.invoices.some((x) => x.id === fx.invoiceId && x.status === 'paid') &&
        s.subs.some((x) => x.id === fx.subId && x.status === 'active');
      const outcomeB = purchase.status === 'void' && s.invoices.some((x) => x.id === fx.invoiceId && x.status === 'void') &&
        s.subs.some((x) => x.id === fx.subId && x.status === 'abandoned') && s.sessions[0].status === 'cancelled';
      const outcomeC = purchase.status === 'open' && res.kind === 'conflict' && res.code === 'SESSION_EXPIRED' && adm.status === 409; // unexpired at admin time, expired at success time
      const paidUnapplied = s.invoices.some((x) => x.status === 'paid') && s.company.plan === 'trial';
      if (outcomeA) gA += 1;
      if (outcomeB) gB += 1;
      const exactlyOne = [outcomeA, outcomeB, outcomeC].filter(Boolean).length === 1;
      if (!exactlyOne || paidUnapplied) {
        gOk = false;
        console.log(`    G[${i}] incoherent: admin=${adm.status}/${adm.body && adm.body.code} res=${res.kind}/${res.code} purchase=${purchase.status}`);
      }
      if (outcomeB && res.kind !== 'conflict') gOk = false;
      if (outcomeA && useUpdate && s.company.subscription_status !== 'active' && s.company.subscription_status !== 'suspended') gOk = false;
    }
    check(`admin action vs simulator success at the deadline (${ITERATIONS * 2} iterations, activate + suspend): exactly one final state each time, never paid-but-unapplied (applied=${gA}, voided=${gB})`, gOk);

    // ======================================================================
    console.log('\n== H. B2-B6 preservation: a non-purchase (admin) invoice settles exactly as before ==');
    const coH = await newCompany('b2-b6 path');
    const act = await invoke(adminController.activateSubscription, makeReq({ id: coH }, { plan: 'bronze', billing_interval: 'monthly', currency: 'USD', period_amount: 32 }));
    const inv = await invoke(adminController.createSubscriptionInvoice, makeReq({ id: coH }, {}));
    const att = (await setup.query(
      `INSERT INTO payment_attempts (invoice_id, company_id, subscription_id, amount, currency, plan, billing_interval, period_start, period_end, idempotency_key, status)
       SELECT id, company_id, subscription_id, amount, currency, plan, billing_interval, period_start, period_end, 'smoke-b7-h', 'initiated'
       FROM invoices WHERE id = $1 RETURNING id`, [inv.body.invoice.id])).rows[0];
    const sess = (await setup.query(`INSERT INTO payment_checkout_sessions (payment_attempt_id, status) VALUES ($1, 'pending') RETURNING id`, [att.id])).rows[0];
    const beforeH = await state(coH);
    const resH = await resolveCheckoutSessionCore(pool, sess.id, 'succeeded');
    const afterH = await state(coH);
    check('B2 activation (201) + B3 invoice (201) still work with the B7 guards in place', act.status === 201 && inv.status === 201, [act.status, inv.status]);
    check('B6 settlement of a non-purchase invoice: invoice paid, no purchase apply, subscription/company rows unchanged',
      resH.kind === 'ok' && !resH.purchaseApplied && !resH.purchaseId && afterH.invoices[0].status === 'paid' &&
      JSON.stringify(afterH.subs) === JSON.stringify(beforeH.subs) && JSON.stringify(afterH.company) === JSON.stringify(beforeH.company));

    // ======================================================================
    console.log('\n== I. Deadlocks ==');
    const logDeadlocks = (await setup.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = $1`, [DB_NAME])).rows[0].deadlocks;
    check(`zero 40P01 deadlocks observed by the app (${deadlocks.length}) and by pg_stat_database (${logDeadlocks})`, deadlocks.length === 0 && Number(logDeadlocks) === 0, deadlocks);

    const failed = checks.filter(([, pass]) => !pass);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
    exitCode = failed.length === 0 ? 0 : 1;
  } catch (err) {
    console.error('SMOKE RUN ERROR:', err);
    exitCode = 1;
  } finally {
    if (appPool) await appPool.end().catch(() => {});
    for (const c of openClients) await c.end().catch(() => {});
    if (dbCreated) {
      const cleanup = new Client(clientConfig(parsedConfig.database));
      try {
        await cleanup.connect();
        await cleanup.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB_NAME]);
        await cleanup.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
        console.log(`Dropped disposable database ${DB_NAME}.`);
      } catch (e) {
        console.error(`CLEANUP FAILED: could not confirm ${DB_NAME} was dropped (${e.message}). It may still exist: DROP DATABASE ${DB_NAME};`);
        exitCode = 1;
      } finally {
        await cleanup.end().catch(() => {});
      }
    }
  }
  process.exit(exitCode);
}

main();
