#!/usr/bin/env node
// Read-only preflight + post-deploy check for Stage B8.2 — production-safe
// expired self-service purchase cleanup. Binding design:
// claude/chat8c-b8-2-expired-purchase-cleanup-design-pass-v3-2026-09-27.md
// (§10.3, §10.4, §10.4.1, §10.5).
//
// Every statement runs inside `BEGIN READ ONLY` with `SET LOCAL TimeZone = 'UTC'`
// and ends with ROLLBACK. Nothing in the database is ever modified. The only
// file this script can write is the P9 snapshot, and only OUTSIDE the
// repository, never overwriting an existing file.
//
// Modes:
//   Pre-enable (preflight of record — run right before enabling the flag):
//     node docs/PREFLIGHT_B8_2_expired_purchase_cleanup_check.js --snapshot-out <file outside the repo>
//   Early check only (no snapshot file):
//     node docs/PREFLIGHT_B8_2_expired_purchase_cleanup_check.js --checks-only
//   Post-enable (after the backlog drained):
//     node docs/PREFLIGHT_B8_2_expired_purchase_cleanup_check.js --post-deploy <snapshot file>
//
// Connection: DATABASE_URL (like every PREFLIGHT_B* script). PowerShell:
//   $env:DATABASE_URL = '<connection string>'
//
// Exit codes: 0 = pass, 2 = STOP (read the >>> STOP lines), 1 = usage/connection error.
//
// Output privacy: UUIDs, invoice numbers, plan/status codes, timestamps,
// counts, classes and md5 hashes only. Never a company or user name, an
// email, a token, a secret or simulator credential.

const fs = require('fs');
const path = require('path');

const SNAPSHOT_VERSION = 1;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_TRIGGERS = {
  subscriptions: 'subscriptions_guard_pending_trg',
  invoices: 'invoices_guard_status_transition_trg',
  subscription_purchases: 'subscription_purchases_guard_mutation_trg',
  payment_attempts: 'payment_attempts_guard_mutation_trg',
  payment_checkout_sessions: 'payment_checkout_sessions_guard_mutation_trg',
};
const CLOCK_STAMPING_GUARDS = [
  'subscription_purchases_guard_mutation',
  'payment_attempts_guard_mutation',
  'payment_checkout_sessions_guard_mutation',
];
const PROVIDER_SAMPLES = { simulated: true, myfatoorah: false, bede: false, SIMULATED: false, '': false };
const BILLING_EVENT_ACTIONS = ['admin_company_billing_updated', 'admin_subscription_activated', 'subscription_purchase_applied', 'company_updated'];

// ---------------------------------------------------------------------------
// Shared SQL fragments — used verbatim by BOTH the snapshot and the post-deploy
// comparison, so both sides compute identical text (design v3 §10.4.1).
// `c` = companies, `s` = the source subscriptions row.
// ---------------------------------------------------------------------------
const SQL_COMPANY_FIELDS = `
  c.plan AS company_plan,
  c.subscription_status AS company_subscription_status,
  CASE WHEN c.trial_start_date IS NULL THEN NULL ELSE to_char(c.trial_start_date, 'YYYY-MM-DD"T"HH24:MI:SS.US') END AS trial_start_date,
  CASE WHEN c.trial_end_date IS NULL THEN NULL ELSE to_char(c.trial_end_date, 'YYYY-MM-DD"T"HH24:MI:SS.US') END AS trial_end_date,
  ((SELECT count(*) FROM audit_logs a WHERE a.company_id = c.id AND a.action = ANY($BILLING_ACTIONS::text[]))
   + (SELECT count(*) FROM subscription_purchases p WHERE p.company_id = c.id AND p.status = 'completed'))::text AS company_billing_event_count`;
const SQL_SOURCE_FP = `(SELECT md5(row_to_json(s)::text) FROM subscriptions s WHERE s.id = sp.replaces_subscription_id AND s.company_id = sp.company_id)`;

// The §4.3 chain validation for ONE purchase row `sp`, as boolean columns.
const SQL_CHAIN_CHECKS = `
  (SELECT s.status FROM subscriptions s WHERE s.id = sp.subscription_id AND s.company_id = sp.company_id) AS pending_status,
  (SELECT i.status FROM invoices i WHERE i.id = sp.invoice_id AND i.company_id = sp.company_id) AS invoice_status,
  (SELECT s.status FROM subscriptions s WHERE s.id = sp.replaces_subscription_id AND s.company_id = sp.company_id) AS source_status,
  EXISTS (SELECT 1 FROM payment_attempts a WHERE a.invoice_id = sp.invoice_id AND a.status NOT IN ('initiated','failed','cancelled')) AS bad_attempt,
  EXISTS (SELECT 1 FROM payment_attempts a JOIN payment_checkout_sessions ps ON ps.payment_attempt_id = a.id
          WHERE a.invoice_id = sp.invoice_id AND ps.provider IS DISTINCT FROM 'simulated') AS bad_provider,
  EXISTS (SELECT 1 FROM payment_attempts a JOIN payment_checkout_sessions ps ON ps.payment_attempt_id = a.id
          WHERE a.invoice_id = sp.invoice_id
            AND NOT ((a.status = 'initiated' AND ps.status = 'pending')
                  OR (a.status = 'failed' AND ps.status = 'failed')
                  OR (a.status = 'cancelled' AND ps.status = 'cancelled'))) AS bad_pair`;

// Terminal-consistency invariant (§4.4) for void purchases: returns violating ids.
const SQL_VOID_VIOLATIONS = `
  SELECT sp.id FROM subscription_purchases sp
  WHERE sp.status = 'void' AND ($1::uuid[] IS NULL OR sp.id = ANY($1::uuid[])) AND (
       NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = sp.invoice_id AND i.status = 'void' AND i.payment_date IS NULL)
    OR NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = sp.subscription_id AND s.status = 'abandoned')
    OR EXISTS (SELECT 1 FROM payment_attempts a WHERE a.invoice_id = sp.invoice_id AND a.status IN ('initiated','succeeded'))
    OR EXISTS (SELECT 1 FROM payment_attempts a JOIN payment_checkout_sessions ps ON ps.payment_attempt_id = a.id
               WHERE a.invoice_id = sp.invoice_id
                 AND NOT ((a.status = 'failed' AND ps.status = 'failed') OR (a.status = 'cancelled' AND ps.status = 'cancelled')))
    OR EXISTS (SELECT 1 FROM payment_attempts a JOIN payment_checkout_sessions ps ON ps.payment_attempt_id = a.id
               WHERE a.invoice_id = sp.invoice_id AND ps.provider IS DISTINCT FROM 'simulated')
    OR EXISTS (SELECT 1 FROM email_jobs ej WHERE starts_with(ej.dedup_key, 'billing:purchase_confirmed:' || sp.id::text || ':'))
  ) ORDER BY sp.id`;

const withActions = (sql) => sql.split('$BILLING_ACTIONS').join('$1');

function chainIsValid(r) {
  return (
    r.pending_status === 'pending_payment' &&
    r.invoice_status === 'issued' &&
    (r.replaces_subscription_id === null || r.source_status === 'active') &&
    !r.bad_attempt &&
    !r.bad_provider &&
    !r.bad_pair
  );
}

// ---------------------------------------------------------------------------
// Snapshot file format (§10.4.1) — pure helpers, exported for the smoke.
// ---------------------------------------------------------------------------
const UPGRADE_KEYS = ['type', 'kind', 'purchase_id', 'company_id', 'source_subscription_id', 'source_fp', 'company_plan', 'company_subscription_status', 'company_billing_event_count'];
const TRIAL_KEYS = ['type', 'kind', 'purchase_id', 'company_id', 'company_plan', 'company_subscription_status', 'trial_start_date', 'trial_end_date', 'company_billing_event_count'];
const HEADER_KEYS = ['type', 'snapshot_version', 'taken_at', 'row_count'];

function buildSnapshotLines(header, rows) {
  return [JSON.stringify(header), ...rows.map((r) => JSON.stringify(r))];
}

/** Parses and strictly validates snapshot text. Returns { header, rows } or throws with a safe message. */
function parseSnapshot(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('snapshot file is empty');
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    throw new Error('snapshot header is not valid JSON');
  }
  const sameKeys = (obj, keys) => Object.keys(obj).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
  if (!header || header.type !== 'header' || !sameKeys(header, HEADER_KEYS)) throw new Error('snapshot header has an unexpected shape');
  if (header.snapshot_version !== SNAPSHOT_VERSION) throw new Error(`unsupported snapshot_version ${JSON.stringify(header.snapshot_version)}`);
  if (typeof header.taken_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(header.taken_at)) throw new Error('snapshot taken_at is malformed');
  if (!Number.isInteger(header.row_count) || header.row_count !== lines.length - 1) throw new Error('snapshot row_count does not match the number of rows');
  const rows = lines.slice(1).map((line, i) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`snapshot row ${i + 1} is not valid JSON`);
    }
    if (!row || row.type !== 'row' || !['upgrade', 'trial'].includes(row.kind)) throw new Error(`snapshot row ${i + 1} has an unexpected type/kind`);
    if (!sameKeys(row, row.kind === 'upgrade' ? UPGRADE_KEYS : TRIAL_KEYS)) throw new Error(`snapshot row ${i + 1} has unexpected fields`);
    if (!UUID_RE.test(row.purchase_id) || !UUID_RE.test(row.company_id)) throw new Error(`snapshot row ${i + 1} has a malformed id`);
    if (row.kind === 'upgrade' && (!UUID_RE.test(row.source_subscription_id) || !/^[0-9a-f]{32}$/.test(row.source_fp))) {
      throw new Error(`snapshot row ${i + 1} has a malformed source fingerprint`);
    }
    if (!/^\d+$/.test(row.company_billing_event_count)) throw new Error(`snapshot row ${i + 1} has a malformed event count`);
    return row;
  });
  if (new Set(rows.map((r) => r.purchase_id)).size !== rows.length) throw new Error('snapshot contains a duplicate purchase_id');
  return { header, rows };
}

/** Classifies one compared snapshot row (§10.5). */
function classifyComparison(snapshotRow, currentRow) {
  const fields =
    snapshotRow.kind === 'upgrade'
      ? ['source_fp', 'company_plan', 'company_subscription_status']
      : ['company_plan', 'company_subscription_status', 'trial_start_date', 'trial_end_date'];
  const differing = fields.filter((f) => snapshotRow[f] !== currentRow[f]);
  if (differing.length === 0) return { result: 'MATCH', differing };
  const explained = BigInt(currentRow.company_billing_event_count) > BigInt(snapshotRow.company_billing_event_count);
  return { result: explained ? 'MISMATCH_EXPLAINED' : 'MISMATCH_UNEXPLAINED', differing };
}

function isInsideRepo(file) {
  const resolved = path.resolve(file);
  const rel = path.relative(REPO_ROOT, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Database checks
// ---------------------------------------------------------------------------
async function semanticCheckProbe(client, table, column, samples) {
  const constraints = (
    await client.query(
      `SELECT c.conname, pg_get_expr(c.conbin, c.conrelid) AS expr, c.convalidated,
              (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(c.conkey) k
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS cols
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = current_schema() AND t.relname = $1 AND c.contype = 'c'
         AND EXISTS (SELECT 1 FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k WHERE a.attname = $2)`,
      [table, column]
    )
  ).rows;
  const colType = (
    await client.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS t, a.attnotnull FROM pg_attribute a
       JOIN pg_class t ON t.oid = a.attrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = current_schema() AND t.relname = $1 AND a.attname = $2 AND NOT a.attisdropped`,
      [table, column]
    )
  ).rows[0];
  if (!colType) return { ok: false, reason: `column ${table}.${column} not found`, constraints: [] };
  const single = constraints.filter((c) => c.convalidated && Array.isArray(c.cols) && c.cols.length === 1 && c.cols[0] === column);
  if (single.length === 0) return { ok: false, reason: `no validated single-column CHECK on ${table}.${column}`, constraints, notNull: colType.attnotnull };
  const results = {};
  for (const [value, expected] of Object.entries(samples)) {
    let all = true;
    for (const c of single) {
      // Expression text comes from the catalog (pg_get_expr), never from input.
      const r = await client.query(`SELECT (${c.expr}) AS ok FROM (VALUES ($1::${colType.t})) AS t(${column})`, [value]);
      if (r.rows[0].ok !== true) all = false;
    }
    results[value === '' ? "''" : value] = { expected, got: all };
  }
  const ok = Object.values(results).every((r) => r.expected === r.got);
  return { ok, results, constraints: single.map((c) => c.conname), notNull: colType.attnotnull };
}

async function schemaChecks(client, stop) {
  const colExists = async (table, column) =>
    (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, [table, column])).rows.length > 0;
  // P1
  const replaces = await colExists('subscription_purchases', 'replaces_subscription_id');
  const statusProbe = await semanticCheckProbe(client, 'subscriptions', 'status', { superseded: true, active: true, pending_payment: true, abandoned: true, bogus: false });
  console.log(`\n=== P1: MIGRATION_087 applied — replaces_subscription_id=${replaces}, status CHECK semantic probe=${JSON.stringify(statusProbe.results || statusProbe.reason)} ===`);
  if (!replaces || !statusProbe.ok) stop('P1: MIGRATION_087 is not applied as expected (replaces_subscription_id / superseded status).');
  // P2
  const triggers = (
    await client.query(
      `SELECT c.relname AS table_name, tg.tgname AS trigger_name FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'`
    )
  ).rows;
  const missing = Object.entries(KNOWN_TRIGGERS).filter(([t, name]) => !triggers.some((r) => r.table_name === t && r.trigger_name === name)).map(([t, n]) => `${t}.${n}`);
  const clockMissing = [];
  for (const fn of CLOCK_STAMPING_GUARDS) {
    const src = (await client.query(`SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = current_schema() AND p.proname = $1`, [fn])).rows[0]?.prosrc;
    if (!src || !src.includes('clock_timestamp()')) clockMissing.push(fn);
  }
  console.log(`=== P2: guard triggers bound and enabled (missing=[${missing.join(', ') || 'none'}]); clock_timestamp() stamping guards (missing=[${clockMissing.join(', ') || 'none'}]) ===`);
  if (missing.length || clockMissing.length) stop('P2: a billing guard trigger is missing/disabled or a stamping guard does not use clock_timestamp().');
  // P3
  const providerProbe = await semanticCheckProbe(client, 'payment_checkout_sessions', 'provider', PROVIDER_SAMPLES);
  const providerImmutable = (
    await client.query(`SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = current_schema() AND p.proname = 'payment_checkout_sessions_guard_mutation'`)
  ).rows[0]?.prosrc?.includes('NEW.provider');
  console.log(`=== P3: provider CHECK semantic probe=${JSON.stringify(providerProbe.results || providerProbe.reason)}, NOT NULL=${providerProbe.notNull}, immutability guard=${!!providerImmutable} ===`);
  if (!providerProbe.ok || !providerProbe.notNull || !providerImmutable) {
    stop("P3: payment_checkout_sessions.provider is not constrained to exactly 'simulated' (the B8.2 tripwire assumption). A real provider stage must redesign cleanup first.");
  }
}

async function purchaseChecks(client, stop) {
  // P4 / P5
  const expired = (
    await client.query(
      `SELECT sp.id, sp.company_id, sp.replaces_subscription_id, i.invoice_number,
              CASE WHEN sp.replaces_subscription_id IS NULL THEN 'trial' ELSE 'upgrade' END AS kind,
              floor(extract(epoch FROM (clock_timestamp() - sp.expires_at)) / 60)::int AS minutes_past_expiry,
              ${SQL_CHAIN_CHECKS}
       FROM subscription_purchases sp LEFT JOIN invoices i ON i.id = sp.invoice_id
       WHERE sp.status = 'open' AND sp.expires_at <= clock_timestamp()
       ORDER BY sp.expires_at, sp.id`
    )
  ).rows;
  const openCount = (await client.query(`SELECT count(*)::int AS n FROM subscription_purchases WHERE status = 'open'`)).rows[0].n;
  console.log(`\n=== P4: open purchases=${openCount}; expired open purchases=${expired.length} ===`);
  if (expired.length) console.table(expired.map((r) => ({ purchase_id: r.id, company_id: r.company_id, invoice_number: r.invoice_number, kind: r.kind, minutes_past_expiry: r.minutes_past_expiry })));
  const invalid = expired.filter((r) => !chainIsValid(r));
  console.log(`=== P5: expired open purchases failing chain validation=${invalid.length} ===`);
  if (invalid.length) {
    console.table(invalid.map((r) => ({ purchase_id: r.id, pending: r.pending_status, invoice: r.invoice_status, source: r.source_status, bad_attempt: r.bad_attempt, bad_provider: r.bad_provider, bad_pair: r.bad_pair })));
    stop('P5: one or more expired open purchases would be refused by the cleanup (anomaly/provider guard). Investigate before enabling.');
  }
  // P6
  const p6 = (
    await client.query(
      `SELECT sp.id FROM subscription_purchases sp
       WHERE sp.status = 'open' AND (
         NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = sp.invoice_id AND i.status = 'issued')
         OR (sp.replaces_subscription_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM subscriptions s WHERE s.id = sp.replaces_subscription_id AND s.company_id = sp.company_id AND s.status = 'active')))
       ORDER BY sp.id`
    )
  ).rows;
  console.log(`=== P6: open purchases with a non-issued invoice or a non-active source=${p6.length} ===`);
  if (p6.length) stop(`P6: ${p6.map((r) => r.id).join(', ')}`);
  // P7
  const p7 = (await client.query(SQL_VOID_VIOLATIONS, [null])).rows;
  console.log(`=== P7: void purchases violating the terminal-consistency invariant=${p7.length} ===`);
  if (p7.length) stop(`P7: ${p7.map((r) => r.id).join(', ')}`);
  // P8
  const p8 = (await client.query(confirmationJobsForNonCompletedSql())).rows[0].n;
  console.log(`=== P8: confirmation jobs linked to non-completed purchases=${p8} ===`);
  if (p8 > 0) stop('P8: confirmation email jobs exist for non-completed purchases.');
  return expired;
}

function confirmationJobsForNonCompletedSql() {
  return `SELECT count(*)::int AS n FROM email_jobs ej
          JOIN subscription_purchases sp ON starts_with(ej.dedup_key, 'billing:purchase_confirmed:' || sp.id::text || ':')
          WHERE sp.status <> 'completed'`;
}

async function snapshotRows(client) {
  const header = (
    await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS taken_at`)
  ).rows[0];
  const rows = (
    await client.query(
      withActions(`SELECT sp.id AS purchase_id, sp.company_id, sp.replaces_subscription_id AS source_subscription_id,
              ${SQL_SOURCE_FP} AS source_fp, ${SQL_COMPANY_FIELDS}
       FROM subscription_purchases sp JOIN companies c ON c.id = sp.company_id
       WHERE sp.status = 'open' AND sp.expires_at <= clock_timestamp()
       ORDER BY sp.expires_at, sp.id`),
      [BILLING_EVENT_ACTIONS]
    )
  ).rows.map((r) =>
    r.source_subscription_id
      ? {
          type: 'row',
          kind: 'upgrade',
          purchase_id: r.purchase_id,
          company_id: r.company_id,
          source_subscription_id: r.source_subscription_id,
          source_fp: r.source_fp,
          company_plan: r.company_plan,
          company_subscription_status: r.company_subscription_status,
          company_billing_event_count: r.company_billing_event_count,
        }
      : {
          type: 'row',
          kind: 'trial',
          purchase_id: r.purchase_id,
          company_id: r.company_id,
          company_plan: r.company_plan,
          company_subscription_status: r.company_subscription_status,
          trial_start_date: r.trial_start_date,
          trial_end_date: r.trial_end_date,
          company_billing_event_count: r.company_billing_event_count,
        }
  );
  return { header: { type: 'header', snapshot_version: SNAPSHOT_VERSION, taken_at: header.taken_at, row_count: rows.length }, rows };
}

async function postDeploy(client, snapshot, stop) {
  const ids = snapshot.rows.map((r) => r.purchase_id);
  // Current state of every snapshot purchase.
  const current = (
    await client.query(
      withActions(`SELECT sp.id AS purchase_id, sp.company_id, sp.status, sp.replaces_subscription_id,
              ${SQL_SOURCE_FP} AS source_fp,
              (SELECT s.status FROM subscriptions s WHERE s.id = sp.replaces_subscription_id AND s.company_id = sp.company_id) AS source_status,
              (SELECT a.new_values->>'reason' FROM audit_logs a
                 WHERE a.entity_type = 'subscription_purchases' AND a.entity_id = sp.id AND a.action = 'subscription_purchase_voided'
                 ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS void_reason,
              ${SQL_COMPANY_FIELDS}
       FROM subscription_purchases sp JOIN companies c ON c.id = sp.company_id
       WHERE sp.id = ANY($2::uuid[])`),
      [BILLING_EVENT_ACTIONS, ids]
    )
  ).rows;
  const byId = new Map(current.map((r) => [r.purchase_id, r]));
  const report = [];
  const counts = {};
  for (const snap of snapshot.rows) {
    const cur = byId.get(snap.purchase_id);
    let cls;
    let result = '';
    let differing = [];
    if (!cur) {
      cls = 'UNKNOWN_PURCHASE';
      stop(`snapshot purchase ${snap.purchase_id} does not exist in this database (wrong database or wrong snapshot file).`);
    } else if (cur.company_id !== snap.company_id || (snap.kind === 'upgrade') !== !!cur.replaces_subscription_id ||
               (snap.kind === 'upgrade' && cur.replaces_subscription_id !== snap.source_subscription_id)) {
      cls = 'IDENTITY_MISMATCH';
      stop(`snapshot purchase ${snap.purchase_id} does not match its database row (company/kind/source).`);
    } else if (cur.status === 'completed') {
      cls = 'IMPOSSIBLE';
      stop(`snapshot purchase ${snap.purchase_id} is completed — an expired purchase cannot complete.`);
    } else if (cur.status === 'open') {
      cls = 'PENDING';
    } else if (cur.void_reason === 'expired_cleanup' || cur.void_reason === null) {
      cls = cur.void_reason === null ? 'CLEANED_NO_AUDIT' : 'CLEANED';
      const c = classifyComparison(snap, cur);
      result = c.result;
      differing = c.differing;
      if (c.result === 'MISMATCH_UNEXPLAINED') stop(`Q${snap.kind === 'upgrade' ? 3 : 4}: ${snap.purchase_id} changed (${c.differing.join(', ')}) with no audited billing event since the snapshot.`);
      if (snap.kind === 'upgrade' && cur.source_status === 'superseded') {
        const completedReplacers = (
          await client.query(`SELECT count(*)::int AS n FROM subscription_purchases WHERE replaces_subscription_id = $1 AND status = 'completed' AND id <> $2`, [snap.source_subscription_id, snap.purchase_id])
        ).rows[0].n;
        if (completedReplacers !== 1) stop(`Q3(c): source of ${snap.purchase_id} is superseded without exactly one other completed upgrade.`);
      }
    } else {
      cls = 'OTHER_VOID';
    }
    counts[cls] = (counts[cls] || 0) + 1;
    report.push({ purchase_id: snap.purchase_id, kind: snap.kind, class: cls, result, differing: differing.join(',') });
  }
  console.log(`\n=== Q3/Q4: snapshot purchases (${snapshot.rows.length}) — ${JSON.stringify(counts)} ===`);
  if (report.length) console.table(report);

  // Q1 — open purchases expired > 10 minutes that pass chain validation (anomalies listed separately).
  const staleOpen = (
    await client.query(
      `SELECT sp.id, sp.replaces_subscription_id, ${SQL_CHAIN_CHECKS}
       FROM subscription_purchases sp WHERE sp.status = 'open' AND sp.expires_at <= clock_timestamp() - interval '10 minutes'`
    )
  ).rows;
  const q1 = staleOpen.filter(chainIsValid);
  const anomalies = staleOpen.filter((r) => !chainIsValid(r));
  console.log(`=== Q1: valid open purchases expired > 10 minutes=${q1.length}; anomalous (excluded, investigate)=${anomalies.length} ===`);
  if (anomalies.length) console.table(anomalies.map((r) => ({ purchase_id: r.id })));
  if (q1.length) stop(`Q1: ${q1.length} valid expired purchase(s) are still open — is the cleanup enabled and running?`);
  // Q2
  const q2 = (await client.query(SQL_VOID_VIOLATIONS, [null])).rows;
  console.log(`=== Q2: void purchases violating the invariant=${q2.length} ===`);
  if (q2.length) stop(`Q2: ${q2.map((r) => r.id).join(', ')}`);
  // Q5
  const q5 = (await client.query(confirmationJobsForNonCompletedSql())).rows[0].n;
  console.log(`=== Q5: confirmation jobs for non-completed purchases=${q5} ===`);
  if (q5 > 0) stop('Q5: confirmation email jobs exist for non-completed purchases.');
  // Q6 — informational
  const q6 = (
    await client.query(
      `SELECT count(*)::int AS n FROM subscription_purchases sp
       WHERE sp.status = 'void' AND sp.voided_at >= sp.expires_at AND sp.voided_at >= $1::timestamptz
         AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.entity_type = 'subscription_purchases' AND a.entity_id = sp.id AND a.action = 'subscription_purchase_voided')`,
      [snapshot.header.taken_at]
    )
  ).rows[0].n;
  console.log(`=== Q6 (informational): sweep voids since the snapshot with no audit row=${q6}; snapshot rows CLEANED_NO_AUDIT=${counts.CLEANED_NO_AUDIT || 0} ===`);
  // Q7
  const q7 = (await client.query(`SELECT count(*)::int AS n FROM invoices WHERE status = 'void' AND payment_date IS NOT NULL`)).rows[0].n;
  console.log(`=== Q7: void invoices carrying a payment_date=${q7} ===`);
  if (q7 > 0) stop('Q7: a void invoice carries a payment_date.');
  // Q8 — purchases voided after the snapshot that the snapshot never contained: invariants only.
  const post = (
    await client.query(
      `SELECT sp.id, sp.company_id, sp.replaces_subscription_id,
              (SELECT s.status FROM subscriptions s WHERE s.id = sp.replaces_subscription_id AND s.company_id = sp.company_id) AS source_status,
              (SELECT count(*)::int FROM subscription_purchases p2 WHERE p2.replaces_subscription_id = sp.replaces_subscription_id AND p2.status = 'completed' AND p2.id <> sp.id) AS other_completed
       FROM subscription_purchases sp
       WHERE sp.status = 'void' AND sp.voided_at >= $1::timestamptz AND NOT (sp.id = ANY($2::uuid[]))`,
      [snapshot.header.taken_at, ids]
    )
  ).rows;
  const postIds = post.map((r) => r.id);
  const q8Chain = postIds.length ? (await client.query(SQL_VOID_VIOLATIONS, [postIds])).rows : [];
  const q8Source = post.filter((r) => r.replaces_subscription_id && (r.source_status === null || (r.source_status === 'superseded' && r.other_completed !== 1)));
  console.log(`=== Q8: post-snapshot voids (no before/after comparison possible)=${post.length}; invariant violations: chain=${q8Chain.length}, source=${q8Source.length} ===`);
  if (q8Chain.length || q8Source.length) stop(`Q8: ${[...q8Chain.map((r) => r.id), ...q8Source.map((r) => r.id)].join(', ')}`);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1] ?? '';
  };
  const snapshotOut = flag('--snapshot-out');
  const postDeployFile = flag('--post-deploy');
  const checksOnly = args.includes('--checks-only');
  const modes = [snapshotOut !== undefined, postDeployFile !== undefined, checksOnly].filter(Boolean).length;
  if (modes !== 1) {
    console.error('Usage: --snapshot-out <file outside the repo> | --checks-only | --post-deploy <snapshot file>');
    process.exitCode = 1;
    return;
  }
  if (snapshotOut !== undefined) {
    if (!snapshotOut) {
      console.error('--snapshot-out needs a file path.');
      process.exitCode = 1;
      return;
    }
    if (isInsideRepo(snapshotOut)) {
      console.error('REFUSING: the snapshot file must be written OUTSIDE the repository.');
      process.exitCode = 1;
      return;
    }
    if (fs.existsSync(snapshotOut)) {
      console.error('REFUSING: the snapshot file already exists; choose a new path.');
      process.exitCode = 1;
      return;
    }
  }
  let snapshot = null;
  if (postDeployFile !== undefined) {
    try {
      snapshot = parseSnapshot(fs.readFileSync(postDeployFile, 'utf8'));
    } catch (e) {
      console.log(`\n>>> STOP: snapshot file rejected — ${e.message}`);
      process.exitCode = 2;
      return;
    }
  }

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
  const stop = (m) => stops.push(m);
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL TimeZone = 'UTC'`);
    await schemaChecks(client, stop);
    if (snapshot) {
      await postDeploy(client, snapshot, stop);
    } else {
      await purchaseChecks(client, stop);
      if (snapshotOut !== undefined && stops.length === 0) {
        const snap = await snapshotRows(client);
        const lines = buildSnapshotLines(snap.header, snap.rows);
        fs.writeFileSync(snapshotOut, `${lines.join('\n')}\n`, { flag: 'wx' });
        console.log('\n=== B8_2_SNAPSHOT BEGIN ===');
        for (const l of lines) console.log(l);
        console.log('=== B8_2_SNAPSHOT END ===');
        console.log(`P9: snapshot of record written (${snap.rows.length} row(s)) to the file given with --snapshot-out.`);
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
  if (stops.length) {
    for (const s of stops) console.log(`\n>>> STOP: ${s}`);
    if (snapshotOut !== undefined) console.log('\n(No snapshot file was written because a STOP condition exists.)');
    process.exitCode = 2;
  } else if (postDeployFile !== undefined) {
    console.log('\n>>> Post-deploy check passed: every snapshot purchase is MATCH / explained / pending / other-void, and every current invariant (Q1, Q2, Q5, Q7, Q8) holds.');
  } else {
    console.log(`\n>>> Preflight passed (P1–P8).${snapshotOut !== undefined ? ' Snapshot of record saved; enable ENABLE_EXPIRED_PURCHASE_CLEANUP right away.' : ''}`);
  }
}

module.exports = {
  SNAPSHOT_VERSION,
  PROVIDER_SAMPLES,
  buildSnapshotLines,
  parseSnapshot,
  classifyComparison,
  isInsideRepo,
  chainIsValid,
};

if (require.main === module) {
  main().catch((err) => {
    const code = err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) ? ` (SQLSTATE ${err.code})` : '';
    console.error(`Preflight check failed${code}.`);
    process.exitCode = 1;
  });
}
