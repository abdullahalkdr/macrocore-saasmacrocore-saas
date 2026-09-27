/* eslint-disable no-console */
/**
 * SMOKE_B8_1_purchase_confirmation_email.js — Stage B8.1 real-PostgreSQL smoke.
 * Design: claude/chat8b-b8-1-subscription-confirmation-email-design-pass-v2-2026-09-27.md
 * (§4, §4.2, §13.2: T-DB-1 … T-DB-9).
 *
 * Creates ONE disposable database on a local PostgreSQL server you control,
 * builds the schema through MIGRATION_087 from the real files, runs the real
 * services (subscriptionPurchase / paymentSettlement / utils/email) against it,
 * then drops it. Every client is closed before DROP DATABASE; a cleanup
 * failure fails the run.
 *
 * Never reads DATABASE_URL or any .env file. RESEND_API_KEY is forced empty
 * and NODE_ENV is not 'production', so the existing worker's dev path
 * ('dev_skipped') is the only delivery outcome — no email provider is ever
 * contacted. Only localhost / 127.0.0.1 targets are accepted.
 *
 * Run with (bash):
 *   SMOKE_CONCURRENCY_ADMIN_URL="postgres://pguser@127.0.0.1:55432/postgres" \
 *   SMOKE_CONFIRM_DISPOSABLE=yes \
 *     node docs/SMOKE_B8_1_purchase_confirmation_email.js
 *
 * Optional: SMOKE_B8_1_ITERATIONS (default 6). The role needs CREATEDB and
 * superuser (T-DB-9 uses session_replication_role inside a rolled-back
 * transaction).
 */

const { Client } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RAW_ADMIN_URL = process.env.SMOKE_CONCURRENCY_ADMIN_URL;
const CONFIRM_DISPOSABLE = process.env.SMOKE_CONFIRM_DISPOSABLE;
const ITERATIONS = Number.parseInt(process.env.SMOKE_B8_1_ITERATIONS || '6', 10);

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
const DB_NAME = `smoke_b8_1_email_${RUN_ID}`;
const port = parsedConfig.port || 5432;
const userPart = parsedConfig.user ? `${encodeURIComponent(parsedConfig.user)}${parsedConfig.password ? `:${encodeURIComponent(parsedConfig.password)}` : ''}@` : '';
const APP_DB_URL = `postgres://${userPart}${rawHost}:${port}/${DB_NAME}?options=${encodeURIComponent('-c lock_timeout=8000 -c statement_timeout=20000')}`;
console.log(`Target (redacted): postgres://${parsedConfig.user || '(default)'}:***@${rawHost}:${port}/${DB_NAME}`);

process.env.DATABASE_URL = APP_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-only-jwt-secret-not-real';
process.env.ENABLE_BACKGROUND_SWEEPS = 'false';
process.env.RESEND_API_KEY = '';
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = 'https://app.example.test';

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
  console.log('Built the schema through MIGRATION_087 (real files).');
}

// A Connectable over one dedicated client whose statements can be observed
// and fault-injected: hooks[sqlPrefix] = async (sql) => void | throws.
function hookedConnectable(client, hooks = {}) {
  const query = async (sql, params) => {
    for (const [prefix, fn] of Object.entries(hooks)) {
      if (typeof sql === 'string' && sql.startsWith(prefix)) await fn(sql);
    }
    return client.query(sql, params);
  };
  return { query, connect: async () => ({ query, release: () => {} }) };
}

async function main() {
  const admin = new Client(clientConfig(parsedConfig.database));
  await admin.connect();
  const created = [];
  try {
    console.log(`PostgreSQL server: ${(await admin.query('SELECT version()')).rows[0].version}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    created.push(DB_NAME);
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

    require('ts-node/register/transpile-only');
    const sp = require('../src/services/subscriptionPurchase');
    const { resolveCheckoutSessionCore } = require('../src/services/paymentSettlement');
    const { insertPurchaseConfirmationJobs } = require('../src/services/purchaseConfirmationEmail');
    const emailUtils = require('../src/utils/email');
    const { env } = require('../src/config/env');
    const { catalogPriceText } = require('../src/config/planCatalog');
    const { pool } = require('../src/db/pool');
    appPool = pool;

    const q1 = async (sql, params) => (await setup.query(sql, params)).rows[0];
    const rows = async (sql, params) => (await setup.query(sql, params)).rows;
    async function newCompany(label, overrides = {}) {
      return (await setup.query(
        `INSERT INTO companies (name, plan, subscription_status) VALUES ($1, $2, $3) RETURNING id`,
        [label, overrides.plan || 'trial', overrides.subscription_status || 'trial']
      )).rows[0].id;
    }
    async function addUser(co, email, { role = 'admin', status = 'active', lang = 'ar' } = {}) {
      return (await setup.query(
        `INSERT INTO users (company_id, email, role, status, preferred_language) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [co, email, role, status, lang]
      )).rows[0].id;
    }
    async function makePaid(label, plan, interval) {
      const co = await newCompany(label, { plan, subscription_status: 'active' });
      const sub = (await setup.query(
        `WITH c AS (SELECT clock_timestamp() AS t)
         INSERT INTO subscriptions (company_id, plan, status, currency, period_amount, monthly_price, billing_interval,
                                    current_period_start, current_period_end, auto_renew, next_billing_date)
         SELECT $1, $2, 'active', 'USD', $3::numeric, $3::numeric, $4, c.t,
                ((c.t AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC', false,
                ((c.t AT TIME ZONE 'UTC') + interval '1 month')
         FROM c RETURNING id`,
        [co, plan, catalogPriceText(plan, interval), interval]
      )).rows[0];
      return { co, src: sub.id };
    }
    const trialConfirm = (co, plan = 'silver', interval = 'monthly') =>
      sp.confirmPurchase(pool, { companyId: co, plan, interval, currency: 'USD', amountText: catalogPriceText(plan, interval) });
    const upgrade = (co, plan, interval, expected) =>
      sp.confirmPurchase(pool, { companyId: co, plan, interval, currency: 'USD', amountText: catalogPriceText(plan, interval), expectedSourceSubscriptionId: expected });
    const jobsFor = (purchaseId) =>
      rows(
        `SELECT id, company_id, category, dedup_key, recipient_email, lang, subject, html, status, attempt_count, related_entity_type, related_entity_id
         FROM email_jobs WHERE related_entity_type = 'subscription_purchases' AND related_entity_id = $1 ORDER BY dedup_key`,
        [purchaseId]
      );
    const allConfirmationJobs = async () => (await q1(`SELECT count(*)::int AS n FROM email_jobs WHERE dedup_key LIKE 'billing:purchase_confirmed:%'`)).n;
    const quiet = async (fn) => {
      const log = console.log;
      const err = console.error;
      const warn = console.warn;
      console.log = () => {};
      console.error = () => {};
      console.warn = () => {};
      try {
        return await fn();
      } finally {
        console.log = log;
        console.error = err;
        console.warn = warn;
      }
    };
    const startDeadlocks = Number((await q1(`SELECT deadlocks FROM pg_stat_database WHERE datname = $1`, [DB_NAME])).deadlocks);

    // ======================================================================
    console.log('\n== T-DB-1 — B7 trial purchase: recipients, tenant isolation, job fields ==');
    const coT = await newCompany('Trial <Co> & Sons');
    const uAr = await addUser(coT, 'ar.admin@example.test', { lang: 'ar' });
    const uEn = await addUser(coT, 'en.admin@example.test', { lang: 'en' });
    await addUser(coT, 'EN.ADMIN@example.test ', { lang: 'ar' }); // duplicate after normalization (later row)
    await addUser(coT, 'inactive.admin@example.test', { status: 'inactive' });
    await addUser(coT, 'employee@example.test', { role: 'employee' });
    const coOther = await newCompany('Other tenant');
    await addUser(coOther, 'other.tenant.admin@example.test');
    const pT = await trialConfirm(coT, 'silver', 'monthly');
    check('order confirmation alone creates no confirmation job', (await jobsFor(pT.purchaseId)).length === 0);
    const cT = await sp.startCheckout(pool, coT, pT.purchaseId);
    check('checkout-session creation alone creates no confirmation job', (await jobsFor(pT.purchaseId)).length === 0);
    const rT = await resolveCheckoutSessionCore(pool, cT.sessionId, 'succeeded');
    const jT = await jobsFor(pT.purchaseId);
    check('B7 success -> exactly 2 jobs (AR + EN; duplicate-case, inactive, non-admin and other-tenant admins excluded)',
      rT.kind === 'ok' && jT.length === 2 && new Set(jT.map((j) => j.recipient_email)).size === 2 &&
      jT.every((j) => ['ar.admin@example.test', 'en.admin@example.test'].includes(j.recipient_email)), jT.map((j) => j.recipient_email));
    check('job fields: billing category, tenant company, subscription_purchases entity, dedup key per recipient, queued, attempt_count 0',
      jT.every((j) => j.category === 'billing' && j.company_id === coT && j.related_entity_type === 'subscription_purchases' && j.related_entity_id === pT.purchaseId &&
        j.status === 'queued' && j.attempt_count === 0) &&
      new Set(jT.map((j) => j.dedup_key)).size === 2 &&
      jT.some((j) => j.dedup_key === `billing:purchase_confirmed:${pT.purchaseId}:${uAr}`) &&
      jT.some((j) => j.dedup_key === `billing:purchase_confirmed:${pT.purchaseId}:${uEn}`));
    const tAr = jT.find((j) => j.lang === 'ar');
    const tEn = jT.find((j) => j.lang === 'en');
    check('language per recipient; simulator prefix + banner; purchase kind wording',
      tAr && tEn && tAr.subject === '[تجريبي] تم تأكيد اشتراكك في macrocore' && tEn.subject === '[Test] Your macrocore subscription is confirmed' &&
      tAr.html.includes('رسالة تأكيد تجريبية — لم يتم خصم أي مبلغ حقيقي.') && tEn.html.includes('Test confirmation — no real amount was charged.') &&
      tAr.html.includes('المستوى') && !tAr.html.includes('المستوى السابق'));
    check('company name escaped; no UUID or token in the stored HTML; link is FRONTEND_URL/account?section=billing',
      jT.every((j) => j.html.includes('Trial &lt;Co&gt; &amp; Sons') && !j.html.includes('<Co>') &&
        !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(j.html) && !/Bearer|simulated-checkout/i.test(j.html) &&
        j.html.includes('https://app.example.test/account?section=billing')));
    const invT = await q1(`SELECT invoice_number, round(amount, 2)::text AS amount FROM invoices i JOIN subscription_purchases sp ON sp.invoice_id = i.id WHERE sp.id = $1`, [pT.purchaseId]);
    check(`exact decimal amount and invoice number from the invoice row (${invT.amount} USD, #${invT.invoice_number})`,
      jT.every((j) => j.html.includes(`<bdi dir="ltr">${invT.amount} USD</bdi>`) && j.html.includes(`#${invT.invoice_number}`)) && invT.amount === catalogPriceText('silver', 'monthly'));
    check('no job was created for the other tenant', (await q1(`SELECT count(*)::int AS n FROM email_jobs WHERE company_id = $1`, [coOther])).n === 0);

    // ======================================================================
    console.log('\n== T-DB-2 — B8 upgrade: previous/new plan from the subscription rows ==');
    const { co: coU, src: srcU } = await makePaid('Upgrade Co', 'bronze', 'monthly');
    await addUser(coU, 'upgrade.en@example.test', { lang: 'en' });
    await addUser(coU, 'upgrade.ar@example.test', { lang: 'ar' });
    const pU = await upgrade(coU, 'silver', 'monthly', srcU);
    const cU = await sp.startCheckout(pool, coU, pU.purchaseId);
    const rU = await resolveCheckoutSessionCore(pool, cU.sessionId, 'succeeded');
    const jU = await jobsFor(pU.purchaseId);
    const uEnJob = jU.find((j) => j.lang === 'en');
    const uArJob = jU.find((j) => j.lang === 'ar');
    check('B8 success -> one upgrade job per admin', rU.kind === 'ok' && jU.length === 2);
    check('upgrade wording: subjects, Previous plan Bronze / New plan Silver, المستوى السابق / المستوى الجديد',
      uEnJob && uArJob && uEnJob.subject === '[Test] Your macrocore plan has been upgraded' && uArJob.subject === '[تجريبي] تمت ترقية اشتراكك في macrocore' &&
      uEnJob.html.includes('Previous plan') && uEnJob.html.includes('Bronze') && uEnJob.html.includes('Silver') &&
      uArJob.html.includes('المستوى السابق') && uArJob.html.includes('برونزي') && uArJob.html.includes('المستوى الجديد') && uArJob.html.includes('فضي'));

    // ======================================================================
    console.log('\n== T-DB-3 — parallel successes and replay ==');
    {
      let ok = true;
      for (let i = 0; i < ITERATIONS; i += 1) {
        const { co, src } = await makePaid(`Race ${i}`, 'bronze', 'monthly');
        await addUser(co, `race${i}.a@example.test`, { lang: 'ar' });
        await addUser(co, `race${i}.b@example.test`, { lang: 'en' });
        const p = await upgrade(co, 'gold', 'monthly', src);
        const c = await sp.startCheckout(pool, co, p.purchaseId);
        const results = await Promise.all(
          [0, 1, 2].map((k) => sleep(k % 2).then(() => resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded')).catch((e) => { noteIfDeadlock(e, 'race'); return { kind: 'error', e }; }))
        );
        const replay = await resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded');
        const j = await jobsFor(p.purchaseId);
        const oks = results.filter((r) => r.kind === 'ok').length;
        if (!(oks === 1 && results.every((r) => r.kind !== 'error') && replay.kind === 'conflict' && j.length === 2)) {
          ok = false;
          console.log(`    race[${i}] oks=${oks} replay=${replay.kind} jobs=${j.length}`);
        }
      }
      check(`${ITERATIONS} × (3 parallel succeeded + 1 replay): exactly one settles, replay is 409, exactly one job per recipient`, ok);
    }

    // ======================================================================
    console.log('\n== T-DB-4 — failed, cancelled, expired, voided/abandoned: zero jobs ==');
    {
      const outcomes = {};
      for (const outcome of ['failed', 'cancelled']) {
        const co = await newCompany(`Neg ${outcome}`);
        await addUser(co, `neg.${outcome}@example.test`);
        const p = await trialConfirm(co);
        const c = await sp.startCheckout(pool, co, p.purchaseId);
        const r = await resolveCheckoutSessionCore(pool, c.sessionId, outcome);
        outcomes[outcome] = r.kind === 'ok' && (await jobsFor(p.purchaseId)).length === 0;
      }
      check('failed and cancelled settle with zero jobs', outcomes.failed && outcomes.cancelled);

      // Expired: shrink the window of a real purchase by bypassing its guard
      // trigger in a replica-mode session (test fixture only), then succeed.
      const coE = await newCompany('Neg expired');
      await addUser(coE, 'neg.expired@example.test');
      const pE = await trialConfirm(coE);
      const cE = await sp.startCheckout(pool, coE, pE.purchaseId);
      await setup.query('BEGIN');
      await setup.query(`SET LOCAL session_replication_role = replica`);
      await setup.query(`UPDATE subscription_purchases SET expires_at = created_at + interval '1 millisecond' WHERE id = $1`, [pE.purchaseId]);
      await setup.query('COMMIT');
      const rE = await resolveCheckoutSessionCore(pool, cE.sessionId, 'succeeded');
      check('expired (gate refused, SESSION_EXPIRED) -> zero jobs', rE.kind === 'conflict' && rE.code === 'SESSION_EXPIRED' && (await jobsFor(pE.purchaseId)).length === 0, rE);

      // Voided / abandoned: a second confirm supersedes the first chain.
      const { co: coV, src: srcV } = await makePaid('Neg void', 'bronze', 'monthly');
      await addUser(coV, 'neg.void@example.test');
      const p1 = await upgrade(coV, 'silver', 'monthly', srcV);
      const c1 = await sp.startCheckout(pool, coV, p1.purchaseId);
      const p2 = await upgrade(coV, 'gold', 'monthly', srcV);
      const r1 = await resolveCheckoutSessionCore(pool, c1.sessionId, 'succeeded');
      const st1 = await q1(`SELECT status FROM subscription_purchases WHERE id = $1`, [p1.purchaseId]);
      const pendingAbandoned = await q1(`SELECT s.status FROM subscriptions s JOIN subscription_purchases sp ON sp.subscription_id = s.id WHERE sp.id = $1`, [p1.purchaseId]);
      check('voided purchase (pending row abandoned) cannot succeed and has zero jobs',
        p2.kind === 'created' && st1.status === 'void' && pendingAbandoned.status === 'abandoned' && r1.kind === 'conflict' && (await jobsFor(p1.purchaseId)).length === 0,
        { p2: p2.kind, st1, pendingAbandoned, r1: r1.kind });
    }

    // ======================================================================
    console.log('\n== T-DB-5 — rollback after the insert leaves no job ==');
    {
      const co = await newCompany('Rollback Co');
      await addUser(co, 'rollback@example.test');
      const p = await trialConfirm(co);
      const c = await sp.startCheckout(pool, co, p.purchaseId);
      const conn = track(new Client(clientConfig(DB_NAME)));
      await conn.connect();
      const db = hookedConnectable(conn, {
        COMMIT: async () => {
          throw Object.assign(new Error('injected COMMIT failure'), { code: '08006' });
        },
      });
      let threw = false;
      try {
        await resolveCheckoutSessionCore(db, c.sessionId, 'succeeded');
      } catch (e) {
        threw = true;
      }
      const s = await q1(`SELECT sp.status AS purchase, i.status AS invoice, pcs.status AS session
                          FROM subscription_purchases sp JOIN invoices i ON i.id = sp.invoice_id
                          JOIN payment_attempts pa ON pa.invoice_id = i.id JOIN payment_checkout_sessions pcs ON pcs.payment_attempt_id = pa.id
                          WHERE sp.id = $1`, [p.purchaseId]);
      check('forced failure at COMMIT -> ROLLBACK: zero jobs, purchase open, invoice issued, session pending',
        threw && (await jobsFor(p.purchaseId)).length === 0 && s.purchase === 'open' && s.invoice === 'issued' && s.session === 'pending', s);
    }

    // ======================================================================
    console.log('\n== T-DB-6 / 6b — job-insert failure: recovery ok vs recovery failure ==');
    await setup.query(`ALTER TABLE email_jobs ADD CONSTRAINT smoke_b8_1_block CHECK (dedup_key NOT LIKE 'billing:purchase_confirmed:%') NOT VALID`);
    try {
      const co = await newCompany('Insert-fail Co');
      await addUser(co, 'insert.fail@example.test');
      const p = await trialConfirm(co);
      const c = await sp.startCheckout(pool, co, p.purchaseId);
      const logs = [];
      const errOrig = console.error;
      console.error = (...a) => logs.push(JSON.stringify(a));
      let r;
      try {
        r = await resolveCheckoutSessionCore(pool, c.sessionId, 'succeeded');
      } finally {
        console.error = errOrig;
      }
      const s = await q1(`SELECT sp.status AS purchase, c.plan FROM subscription_purchases sp JOIN companies c ON c.id = sp.company_id WHERE sp.id = $1`, [p.purchaseId]);
      check('T-DB-6: insert failure with successful savepoint recovery -> settlement committed (purchase completed, plan silver), zero jobs, no exception',
        r && r.kind === 'ok' && s.purchase === 'completed' && s.plan === 'silver' && (await jobsFor(p.purchaseId)).length === 0, { r: r && r.kind, s });
      const joined = logs.join('\n');
      check('T-DB-6: the log line names the purchase and the error class only (no address, HTML, subject, raw message)',
        joined.includes(p.purchaseId) && joined.includes('"errorClass":"insert"') && joined.includes('"pgCode":"23514"') &&
        !/insert\.fail@|smoke_b8_1_block|<div|macrocore subscription|violates/i.test(joined), joined);

      const co2 = await newCompany('Recovery-fail Co');
      await addUser(co2, 'recovery.fail@example.test');
      const p2 = await trialConfirm(co2);
      const c2 = await sp.startCheckout(pool, co2, p2.purchaseId);
      const conn = track(new Client(clientConfig(DB_NAME)));
      await conn.connect();
      const db = hookedConnectable(conn, {
        'ROLLBACK TO SAVEPOINT': async () => {
          throw Object.assign(new Error('injected rollback-to failure'), { code: '25P02' });
        },
      });
      let threw = false;
      await quiet(async () => {
        try {
          await resolveCheckoutSessionCore(db, c2.sessionId, 'succeeded');
        } catch (e) {
          threw = true;
        }
      });
      const s2 = await q1(`SELECT sp.status AS purchase, i.status AS invoice, pcs.status AS session, co.plan
                           FROM subscription_purchases sp JOIN invoices i ON i.id = sp.invoice_id
                           JOIN payment_attempts pa ON pa.invoice_id = i.id JOIN payment_checkout_sessions pcs ON pcs.payment_attempt_id = pa.id
                           JOIN companies co ON co.id = sp.company_id WHERE sp.id = $1`, [p2.purchaseId]);
      check('T-DB-6b: recovery failure -> settlement NOT committed (purchase open, invoice issued, session pending, plan trial), zero jobs',
        threw && s2.purchase === 'open' && s2.invoice === 'issued' && s2.session === 'pending' && s2.plan === 'trial' && (await jobsFor(p2.purchaseId)).length === 0, s2);
    } finally {
      await setup.query(`ALTER TABLE email_jobs DROP CONSTRAINT smoke_b8_1_block`);
    }

    // ======================================================================
    console.log('\n== T-DB-7 / 7a / 7b — visibility and sweep-only delivery ==');
    {
      const co = await newCompany('Sweep Co');
      await addUser(co, 'sweep.a@example.test', { lang: 'ar' });
      await addUser(co, 'sweep.b@example.test', { lang: 'en' });
      const p = await trialConfirm(co);
      const c = await sp.startCheckout(pool, co, p.purchaseId);
      const conn = track(new Client(clientConfig(DB_NAME)));
      await conn.connect();
      let seenDuringTxn = null;
      const db = hookedConnectable(conn, {
        COMMIT: async () => {
          // The helper has already inserted the jobs on `conn`; another
          // connection must not see them, and the worker's claim query must
          // not be able to take them.
          const visible = (await setup.query(`SELECT count(*)::int AS n FROM email_jobs WHERE related_entity_id = $1`, [p.purchaseId])).rows[0].n;
          const claimable = (await setup.query(
            `SELECT count(*)::int AS n FROM (SELECT id FROM email_jobs WHERE related_entity_id = $1 AND status IN ('queued','temp_failed') FOR UPDATE SKIP LOCKED) x`,
            [p.purchaseId]
          )).rows[0].n;
          seenDuringTxn = { visible, claimable };
        },
      });
      const r = await resolveCheckoutSessionCore(db, c.sessionId, 'succeeded');
      check('T-DB-7: while the settlement is open, the jobs are neither visible nor claimable from another connection',
        r.kind === 'ok' && seenDuringTxn && seenDuringTxn.visible === 0 && seenDuringTxn.claimable === 0, seenDuringTxn);

      env.ENABLE_BACKGROUND_SWEEPS = false;
      const disabled = await emailUtils.sweepEmailQueue(50);
      const jobsOff = await jobsFor(p.purchaseId);
      check('T-DB-7a: ENABLE_BACKGROUND_SWEEPS=false -> sweep claims nothing; jobs stay queued with attempt_count 0',
        disabled.claimed === 0 && jobsOff.length === 2 && jobsOff.every((j) => j.status === 'queued' && j.attempt_count === 0), { disabled, jobsOff: jobsOff.map((j) => [j.status, j.attempt_count]) });

      env.ENABLE_BACKGROUND_SWEEPS = true;
      const enabled = await quiet(() => emailUtils.sweepEmailQueue(50));
      const jobsOn = await jobsFor(p.purchaseId);
      check('T-DB-7b: sweeps enabled -> the existing worker claims and processes the same jobs (dev path: dev_skipped, attempt_count 1)',
        enabled.claimed >= 2 && jobsOn.every((j) => j.status === 'dev_skipped' && j.attempt_count === 1), jobsOn.map((j) => [j.status, j.attempt_count]));

      // Retry: a temp-failed confirmation job is claimed again by a later tick.
      let retried = null;
      if (jobsOn[0]) {
        await setup.query(`UPDATE email_jobs SET status = 'temp_failed', next_attempt_at = now() - interval '1 second' WHERE id = $1`, [jobsOn[0].id]);
        await quiet(() => emailUtils.sweepEmailQueue(50));
        retried = await q1(`SELECT status, attempt_count FROM email_jobs WHERE id = $1`, [jobsOn[0].id]);
      }
      check('T-DB-7b: a temp_failed confirmation job is retried by the next sweep tick', !!retried && retried.status === 'dev_skipped' && retried.attempt_count === 2, retried);
      env.ENABLE_BACKGROUND_SWEEPS = false;
    }

    // ======================================================================
    console.log('\n== T-DB-8 — stored HTML is immutable ==');
    {
      const before = await jobsFor(pU.purchaseId);
      await setup.query(`UPDATE companies SET name = 'Renamed Later' WHERE id = $1`, [coU]);
      const pU2 = await upgrade(coU, 'gold', 'monthly', (await q1(`SELECT id FROM subscriptions WHERE company_id = $1 AND status = 'active'`, [coU])).id);
      const cU2 = await sp.startCheckout(pool, coU, pU2.purchaseId);
      await resolveCheckoutSessionCore(pool, cU2.sessionId, 'succeeded');
      const after = await jobsFor(pU.purchaseId);
      const second = await jobsFor(pU2.purchaseId);
      check('a later rename and a later upgrade leave the first purchase jobs byte-identical; the new purchase gets its own jobs',
        after.length === 2 && after.every((j, i) => j.html === before[i].html && j.subject === before[i].subject) &&
        second.length === 2 && second.every((j) => j.html.includes('Renamed Later')) && after.every((j) => !j.html.includes('Renamed Later')));
    }

    // ======================================================================
    console.log('\n== T-DB-9 — exact KWD amount through the real helper (rolled back) ==');
    {
      const conn = track(new Client(clientConfig(DB_NAME)));
      await conn.connect();
      await conn.query('BEGIN');
      await conn.query(`SET LOCAL session_replication_role = replica`);
      const co = (await conn.query(`INSERT INTO companies (name, plan, subscription_status) VALUES ('KWD Co', 'silver', 'active') RETURNING id`)).rows[0].id;
      await conn.query(`INSERT INTO users (company_id, email, role, status, preferred_language) VALUES ($1, 'kwd@example.test', 'admin', 'active', 'en')`, [co]);
      const inv = (await conn.query(
        `INSERT INTO invoices (company_id, subscription_id, plan, billing_interval, currency, amount, period_start, period_end, status, issue_date, due_date, payment_date)
         VALUES ($1, gen_random_uuid(), 'silver', 'monthly', 'KWD', 12.345, now(), now() + interval '1 month', 'paid', now(), now(), now()) RETURNING id`,
        [co]
      )).rows[0].id;
      const purchaseId = crypto.randomUUID();
      await insertPurchaseConfirmationJobs(conn, { companyId: co, purchaseId, invoiceId: inv, kind: 'purchase', newPlan: 'silver', previousPlan: null, billingInterval: 'monthly', provider: 'simulated' });
      const job = (await conn.query(`SELECT html FROM email_jobs WHERE related_entity_id = $1`, [purchaseId])).rows[0];
      await conn.query('ROLLBACK');
      check('KWD 12.345 is rendered verbatim as <bdi dir="ltr">12.345 KWD</bdi>', job && job.html.includes('<bdi dir="ltr">12.345 KWD</bdi>'));
    }

    // ======================================================================
    console.log('\n== Totals and deadlocks ==');
    check(`every confirmation job in the database belongs to a completed purchase (${await allConfirmationJobs()} jobs)`,
      (await q1(`SELECT count(*)::int AS n FROM email_jobs ej JOIN subscription_purchases sp ON sp.id = ej.related_entity_id
                 WHERE ej.dedup_key LIKE 'billing:purchase_confirmed:%' AND sp.status <> 'completed'`)).n === 0);
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
    if (appPool) await appPool.end().catch(() => {});
    for (const c of openClients) await c.end().catch(() => {});
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
