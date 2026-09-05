import { PoolClient } from 'pg';

// Policy Gate pilot (MIGRATION_074/075) — a transaction-scoped Postgres advisory
// lock on the logical (company_id, permission_key) "slot" a policy_permission_gates
// row would occupy, whether or not that row currently exists yet.
//
// Why this exists (found 2026-09-05, after the FOR UPDATE-based fixes): `SELECT ...
// FOR UPDATE` can only lock a ROW that's already there. The very first time a
// permission_key goes from "no gate configured" to "gated", both
// permissions.controller.ts's setForUser() (deciding whether a newly-requested key
// is gated) and policies.controller.ts's setPermissionGate() (creating that first
// gate row) run a `SELECT ... FROM policy_permission_gates WHERE ...` at the same
// moment, both see zero rows — nothing to lock — and both can proceed as if the
// other hadn't happened, letting a permission grant slip straight into
// user_permissions in the same instant a gate was enabled for it. A session-level
// advisory lock has no such gap: it's keyed on values the caller chooses (here, a
// hash of company_id + permission_key), never on a row's physical existence, so it
// works identically whether the gate row exists yet or not.
//
// `pg_advisory_xact_lock` is transaction-scoped — it releases automatically on
// COMMIT or ROLLBACK on the same connection, so callers MUST take it on the SAME
// `client` they run BEGIN/COMMIT on (a fresh pool.query() call would grab a
// different pooled connection and the lock would never protect anything real).
// Never pair this with an explicit unlock call — there isn't one to call here; the
// transaction boundary is the only release point, which is exactly what "smallest
// transaction-scoped mechanism" calls for.
//
// hashtext() returns a 32-bit int, so the pair (hashtext(company_id),
// hashtext(permission_key)) is a compound key with a theoretical (astronomically
// unlikely at this project's scale) collision chance against some unrelated
// (company, key) pair — the only consequence of a collision would be occasional
// extra, harmless serialization between two logically unrelated slots, never a
// correctness issue.
//
// Every function that touches the gate table for a given permission_key —
// setForUser(), acknowledgePendingGrant(), setPermissionGate() — takes this lock
// FIRST, before any pending_permission_grants/user_permissions row lock, so all
// three fully serialize on the same slot and can never deadlock against each other:
// a transaction that acquires its full set of slot locks before touching any other
// contested row can never be the "waits for a row while holding a row" half of a
// wait cycle.
export async function lockPolicyGateSlot(client: PoolClient, companyId: string, permissionKey: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [companyId, permissionKey]);
}
