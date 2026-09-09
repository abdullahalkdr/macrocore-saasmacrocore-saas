import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// SLA timezone incident (2026-09-09) — proves the actual root cause and the
// actual fix at the pg driver level, independent of any live database and
// independent of this file's own module state. See
// claude/sla-timezone-incident-2026-09-09.md (project doc) for the full
// incident writeup and MIGRATION_079_approval_sla_timestamptz.sql for the fix.
//
// Why isolated CHILD processes, not `process.env.TZ = '...'` inside this one
// vitest process: Node/V8 is free to cache timezone-derived state at process
// start, so flipping process.env.TZ mid-run is not guaranteed to be honored
// consistently across Node versions/platforms — the same non-determinism
// this incident was actually caused by (two real OS processes, two real
// timezones). A fresh child process per TZ is the only fully deterministic
// way to prove this. Each child does nothing but call pg's own exported type
// parsers directly (no DB connection, no app code) and print the resulting
// epoch milliseconds as JSON.
// ---------------------------------------------------------------------------

const TIMESTAMP_NO_TZ_OID = 1114; // `timestamp without time zone` — the old (buggy) column type
const TIMESTAMPTZ_OID = 1184; // `timestamp with time zone` — MIGRATION_079's fixed column type

// The exact raw values involved in the real 2026-09-09 incident: Railway
// (UTC) computed the correct reminder cycle key 2026-09-09T17:59:59.117Z;
// the rogue local Kuwait-timezone (UTC+3) process computed
// 2026-09-09T14:59:59.117Z for the SAME stored deadline — exactly 3 hours
// earlier, which is precisely the Asia/Kuwait UTC offset.
const RAW_NO_TZ = '2026-09-09 17:59:59.117'; // what Postgres sends for a `timestamp` column — no offset
const RAW_TZ = '2026-09-09 17:59:59.117+00'; // what Postgres sends for a `timestamptz` column — explicit offset

function parseInChildProcess(tz: string): { noTzMs: number; tzMs: number } {
  const script = `
    const { types } = require('pg');
    const noTz = types.getTypeParser(${TIMESTAMP_NO_TZ_OID})(${JSON.stringify(RAW_NO_TZ)});
    const tz = types.getTypeParser(${TIMESTAMPTZ_OID})(${JSON.stringify(RAW_TZ)});
    process.stdout.write(JSON.stringify({ noTzMs: noTz.getTime(), tzMs: tz.getTime() }));
  `;
  const stdout = execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env, TZ: tz },
    encoding: 'utf-8',
  });
  return JSON.parse(stdout);
}

describe('SLA timezone incident (2026-09-09) — pg type parser behavior, proven via real child processes', () => {
  it('reproduces the bug: `timestamp without time zone` (OID 1114) parses the SAME raw value to DIFFERENT instants under UTC vs Asia/Kuwait', () => {
    const utc = parseInChildProcess('UTC');
    const kuwait = parseInChildProcess('Asia/Kuwait');
    // This is the actual bug that caused the incident — asserting it still
    // reproduces is what proves the diagnosis, not just the fix.
    expect(utc.noTzMs).not.toBe(kuwait.noTzMs);
    // Asia/Kuwait is UTC+3 with no DST — exactly the 3h gap observed between
    // the real reminder cycle key (17:59:59.117Z) and the real premature
    // breach cycle key (14:59:59.117Z) in the incident evidence.
    expect(utc.noTzMs - kuwait.noTzMs).toBe(3 * 60 * 60 * 1000);
  });

  it('proves the fix: `timestamp with time zone` (OID 1184) parses the SAME raw value to the SAME instant under both UTC and Asia/Kuwait', () => {
    const utc = parseInChildProcess('UTC');
    const kuwait = parseInChildProcess('Asia/Kuwait');
    expect(utc.tzMs).toBe(kuwait.tzMs);
  });

  it('sanity check — both processes agree on the wall-clock instant this incident actually involved', () => {
    const utc = parseInChildProcess('UTC');
    expect(new Date(utc.tzMs).toISOString()).toBe('2026-09-09T17:59:59.117Z');
  });
});
