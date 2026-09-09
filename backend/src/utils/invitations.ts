// Employee invitations — shared service backing both entry points (company
// signup's colleague invites, and the Users page's "+ New" flow — decision 1
// of the 2026-09-09 Phase 3 decisions: one consistent experience, one code
// path). Controllers should never query employee_invitations directly — go
// through here so both entry points stay identical by construction.
import crypto from 'crypto';
import { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { AppError } from '../middleware/errorHandler';
import { enqueueEmail, invitationEmailHtml, EmailLang } from './email';
import { env } from '../config/env';

export type InvitableRole = 'admin' | 'manager' | 'employee' | 'viewer';
export const ALL_ROLES: InvitableRole[] = ['admin', 'manager', 'employee', 'viewer'];

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InvitationRow {
  id: string;
  company_id: string;
  email: string;
  role: InvitableRole;
  full_name: string | null;
  // Nullable — MIGRATION_077 uses ON DELETE SET NULL on this column (and on
  // accepted_user_id/revoked_by) specifically so deleting a user who once
  // invited, accepted, or revoked an invitation is never blocked by this
  // table. See the migration file's header comment.
  invited_by: string | null;
  token_hash: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_user_id: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  preferred_language: EmailLang;
  created_at: string;
  updated_at: string;
}

export function deriveInvitationStatus(row: Pick<InvitationRow, 'accepted_at' | 'revoked_at' | 'expires_at'>): InvitationStatus {
  if (row.accepted_at) return 'accepted';
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at).getTime() < Date.now()) return 'expired';
  return 'pending';
}

// Decision 5: admins may invite into any role; managers only into employee/
// viewer, and can never use this flow to create or promote another manager
// or admin. Kept here (not duplicated in the controller and in
// register()'s colleague-invite path) so both entry points enforce the
// exact same boundary. Deliberately reuses the existing `role` field/
// requireRole system — no new permission key, per decision 5's own wording.
export function rolesInvitableBy(inviterRole: string): InvitableRole[] {
  if (inviterRole === 'admin') return ALL_ROLES;
  if (inviterRole === 'manager') return ['employee', 'viewer'];
  return [];
}

export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

interface CreateOrRefreshInput {
  companyId: string;
  companyName: string;
  email: string;
  role: InvitableRole;
  fullName: string | null;
  invitedBy: string;
  inviterName: string | null;
  preferredLanguage: EmailLang;
}

export type InvitationOutcome =
  | { status: 'sent'; invitation: InvitationRow }
  // The row was created/refreshed successfully, but enqueueEmail() did not
  // actually persist an email_jobs row (jobId === null) — the invitation
  // exists and its link is valid, but nobody's inbox got it yet. Callers
  // must never collapse this into 'sent' (review: never report "Invitation
  // sent" when the email job was not queued).
  | { status: 'sent_email_failed'; invitation: InvitationRow }
  | { status: 'skipped'; reason: 'already_member' | 'conflict_elsewhere' };

// Every concurrent create/refresh/resend/accept for the SAME normalized
// email goes through this lock first (keyed by the email itself via
// hashtext) — this is what makes the cross-company conflict scan below
// race-safe, including the "zero existing rows yet" case where there is
// nothing yet to SELECT ... FOR UPDATE on. Postgres advisory locks taken
// with pg_advisory_xact_lock are automatically released at COMMIT/ROLLBACK,
// so callers never need to unlock explicitly.
//
// Exported (production-review fix #2, 2026-09-09): acceptInvitation() in
// auth.controller.ts now takes this SAME lock, in the SAME position (always
// first, before any row-level FOR UPDATE) as create/refresh/resend. Without
// this, a create/resend could read "no users row for this email yet" with
// an unlocked check, then block on the invitation row's FOR UPDATE lock
// until a concurrent accept committed, then resume and write using that
// now-stale "no account yet" read — producing a fresh pending invitation
// for an email that already has an account. Consistent lock ordering across
// all four lifecycle operations is what closes that window: whichever one
// gets here first for a given email fully finishes (commits or rolls back)
// before the other is allowed to read anything.
export async function acquireEmailLock(client: Pick<PoolClient, 'query'>, email: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
}

// Scans ALL rows for this normalized email (not just an arbitrary first
// row — the bug this replaces) to determine, under a FOR UPDATE lock:
//  - sameCompanyRow: the existing row in THIS company, if any (the target of
//    a same-company refresh/resend), and
//  - crossCompanyConflict: whether some OTHER company currently holds a
//    still-pending invitation for this email (a real decision-11 conflict —
//    an accepted/revoked/expired row elsewhere is history, never a block).
// Callers must already hold acquireEmailLock() for this email before calling
// this, so the scan-then-write it enables can't race another request doing
// the same thing for the same email.
async function scanInvitationRowsForEmail(
  client: Pick<PoolClient, 'query'>,
  email: string,
  companyId: string
): Promise<{ sameCompanyRow: InvitationRow | null; crossCompanyConflict: boolean }> {
  const result = await client.query<InvitationRow>('SELECT * FROM employee_invitations WHERE email = $1 FOR UPDATE', [email]);
  let sameCompanyRow: InvitationRow | null = null;
  let crossCompanyConflict = false;
  for (const row of result.rows) {
    if (row.company_id === companyId) {
      sameCompanyRow = row;
    } else if (deriveInvitationStatus(row) === 'pending') {
      crossCompanyConflict = true;
    }
  }
  return { sameCompanyRow, crossCompanyConflict };
}

// Core of both entry points. Callers must run assertInvitableRole() (or
// check rolesInvitableBy() themselves) BEFORE calling this — it does not
// re-derive the inviter's role itself, since register()'s brand-new admin
// and the Users page's authenticated admin/manager reach this differently.
// Never throws for an expected business condition (already a member here,
// or a conflicting account/invitation elsewhere on the platform) — returns
// a typed outcome instead, so a bulk caller (register()'s colleague-invite
// loop) can report per-invite status without one bad email blocking the
// others (decision 2).
//
// Atomic and concurrency-safe (production-review fix, 2026-09-09): the
// entire check-then-write sequence — the users.email clash check, the
// cross-company conflict scan, and the INSERT/UPDATE itself — now runs
// inside one transaction, serialized per-email by acquireEmailLock(). Two
// concurrent invites/resends for the same email (same company or different
// companies) can no longer both pass a stale check and both write.
export async function createOrRefreshInvitation(input: CreateOrRefreshInput): Promise<InvitationOutcome> {
  const email = normalizeInviteEmail(input.email);
  const client = await pool.connect();
  let toSend: { row: InvitationRow; rawToken: string } | null = null;
  let outcome: InvitationOutcome | null = null;

  try {
    await client.query('BEGIN');
    await acquireEmailLock(client, email);

    // Decision 11: users.email is globally unique across the whole platform
    // (not per-company) — an existing account anywhere means this email can
    // never accept a new invitation under the current single-company-account
    // model. Generic, non-enumerating outcome either way. Checked under the
    // same lock/transaction as everything else so a concurrent
    // register()/acceptInvitation() for this exact email can't slip in
    // between this check and the INSERT below.
    const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      outcome = { status: 'skipped', reason: 'conflict_elsewhere' };
    } else {
      const { sameCompanyRow, crossCompanyConflict } = await scanInvitationRowsForEmail(client, email, input.companyId);

      if (sameCompanyRow?.accepted_at) {
        // Same company: an already-accepted invite means this person already
        // has an account here — not something "resend" can fix.
        outcome = { status: 'skipped', reason: 'already_member' };
      } else if (crossCompanyConflict) {
        // A different, still-pending invitation exists elsewhere — real
        // decision-11 conflict. Checked unconditionally (production-review
        // fix #1, 2026-09-09) — NOT gated behind "no same-company row",
        // because a resolved (expired/revoked) same-company row must not
        // suppress a genuine cross-company conflict. The old
        // `!sameCompanyRow && crossCompanyConflict` condition let this
        // fall through to the refresh branch below whenever a same-company
        // row existed in any state, so refreshing a long-expired/revoked
        // row here could create a second live invitation for an email that
        // another company already has genuinely pending.
        outcome = { status: 'skipped', reason: 'conflict_elsewhere' };
      } else {
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // decision 6: 7 days

        let row: InvitationRow;
        if (sameCompanyRow) {
          // Refresh in place — this is the single mechanism behind "resend"
          // AND "re-invite after expiry/revoke": all three are the same
          // operation (decision 6). Only one token_hash value ever exists
          // for a given (company, email) pair, so the old raw link simply
          // stops matching anything once it's overwritten.
          const result = await client.query<InvitationRow>(
            `UPDATE employee_invitations
             SET role = $1, full_name = $2, invited_by = $3, token_hash = $4, expires_at = $5,
                 accepted_at = NULL, accepted_user_id = NULL, revoked_at = NULL, revoked_by = NULL,
                 preferred_language = $6, updated_at = now()
             WHERE id = $7
             RETURNING *`,
            [input.role, input.fullName, input.invitedBy, tokenHash, expiresAt, input.preferredLanguage, sameCompanyRow.id]
          );
          row = result.rows[0];
        } else {
          const result = await client.query<InvitationRow>(
            `INSERT INTO employee_invitations (company_id, email, role, full_name, invited_by, token_hash, expires_at, preferred_language)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [input.companyId, email, input.role, input.fullName, input.invitedBy, tokenHash, expiresAt, input.preferredLanguage]
          );
          row = result.rows[0];
        }
        toSend = { row, rawToken };
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (outcome) return outcome;
  // toSend is guaranteed set here (the only other path through the try block
  // above either sets outcome or throws before reaching COMMIT).
  const { row, rawToken } = toSend!;
  // Sending the email is deliberately outside the transaction — enqueueEmail
  // does its own write against email_jobs and never throws, but its result
  // decides which outcome we report (review: never say "sent" when the job
  // wasn't actually queued).
  const { queued } = await sendInvitationEmail(row, input.companyName, rawToken, input.inviterName);
  return { status: queued ? 'sent' : 'sent_email_failed', invitation: row };
}

export async function sendInvitationEmail(
  invitation: Pick<InvitationRow, 'id' | 'email' | 'company_id' | 'preferred_language' | 'updated_at'>,
  companyName: string,
  rawToken: string,
  inviterName: string | null
): Promise<{ queued: boolean }> {
  const lang = invitation.preferred_language === 'en' ? 'en' : 'ar';
  const link = `${env.FRONTEND_URL}/accept-invitation?token=${rawToken}`;
  const { jobId } = await enqueueEmail({
    to: invitation.email,
    subject: lang === 'en' ? `You're invited to join ${companyName} on macrocore` : `دعوة للانضمام إلى ${companyName} على macrocore`,
    html: invitationEmailHtml(link, lang, companyName, inviterName),
    category: 'invitation',
    lang,
    // Ties to this exact token generation (updated_at moves every resend), so
    // a resend always produces a fresh email — the previous invitation email
    // for the same person is a distinct business event, not a duplicate.
    dedupKey: `invitation:${invitation.id}:${new Date(invitation.updated_at).getTime()}`,
    companyId: invitation.company_id,
    relatedEntityType: 'employee_invitations',
    relatedEntityId: invitation.id,
  });
  return { queued: jobId !== null };
}

// One-click "Resend" from the Users page's pending-invitations list
// (decision 8) — no form, just regenerates the token/expiry on the exact
// row the admin/manager clicked. Reactivates a revoked invitation too (the
// UI shows the same "Resend" action for Expired/Revoked rows — decision 6's
// "resending invalidates every previous link" applies equally to those).
//
// Atomic and concurrency-safe: wrapped in a transaction, serialized by the
// same per-email advisory lock createOrRefreshInvitation() and
// acceptInvitation() use (resending can bring a revoked/expired row back to
// "pending", which — if some OTHER company now holds a genuinely pending
// invitation for this email, or an account for it now exists (e.g. via a
// concurrent accept) — would recreate the exact decision-11/decision-12
// conflicts those locks protect against on create/accept), and the final
// UPDATE is guarded (WHERE accepted_at IS NULL) as defense in depth against
// a concurrent accept.
export async function resendInvitationById(
  id: string,
  companyId: string,
  companyName: string,
  inviterName: string | null
): Promise<{ invitation: InvitationRow; queued: boolean }> {
  const client = await pool.connect();
  let toSend: { row: InvitationRow; rawToken: string } | null = null;

  try {
    await client.query('BEGIN');

    // Cheap, unlocked lookup just to learn the email this row belongs to —
    // acquireEmailLock() needs it, and email is immutable on this row so a
    // stale read here is harmless (the real guard is the FOR UPDATE scan
    // that follows, taken AFTER the lock).
    const lookup = await client.query<Pick<InvitationRow, 'email'>>(
      'SELECT email FROM employee_invitations WHERE id = $1 AND company_id = $2',
      [id, companyId]
    );
    const email = lookup.rows[0]?.email;
    if (!email) throw new AppError(404, 'Invitation not found');

    await acquireEmailLock(client, email);

    // Re-check under the same lock (production-review fix #3, 2026-09-09):
    // an account for this email may have been created — most plausibly by a
    // concurrent acceptInvitation() on this very row, but also directly —
    // since this invitation was last touched. Regenerating and re-emailing
    // a link at that point would be actively wrong (decision 12: existing
    // accounts stay unaffected), so refuse outright rather than resend into
    // that state.
    const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      throw new AppError(409, 'An account already exists for this email');
    }

    const { sameCompanyRow, crossCompanyConflict } = await scanInvitationRowsForEmail(client, email, companyId);
    const row = sameCompanyRow;
    if (!row || row.id !== id) throw new AppError(404, 'Invitation not found');
    if (row.accepted_at) throw new AppError(409, 'This invitation was already accepted');
    if (crossCompanyConflict) {
      throw new AppError(409, 'This email now has a pending invitation with another company — it can’t be resent here');
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const result = await client.query<InvitationRow>(
      `UPDATE employee_invitations
       SET token_hash = $1, expires_at = $2, revoked_at = NULL, revoked_by = NULL, updated_at = now()
       WHERE id = $3 AND accepted_at IS NULL
       RETURNING *`,
      [tokenHash, expiresAt, id]
    );
    const updated = result.rows[0];
    if (!updated) throw new AppError(409, 'This invitation was already accepted');

    toSend = { row: updated, rawToken };
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { row, rawToken: sentRawToken } = toSend!;
  const { queued } = await sendInvitationEmail(row, companyName, sentRawToken, inviterName);
  return { invitation: row, queued };
}

// Decision 8's "Revoke" action. Idempotent on an already-revoked row; refused
// on an already-accepted one — the person already has an account, revoking
// the (long since consumed) invitation link has no meaning at that point.
// FOR UPDATE + a guarded UPDATE (WHERE accepted_at IS NULL) so a revoke
// racing a concurrent accept can never win against an already-accepted row.
export async function revokeInvitationById(id: string, companyId: string, revokedBy: string): Promise<InvitationRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<InvitationRow>(
      'SELECT * FROM employee_invitations WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [id, companyId]
    );
    const row = existing.rows[0];
    if (!row) throw new AppError(404, 'Invitation not found');
    if (row.accepted_at) throw new AppError(409, 'This invitation was already accepted');

    const result = await client.query<InvitationRow>(
      `UPDATE employee_invitations SET revoked_at = now(), revoked_by = $1, updated_at = now()
       WHERE id = $2 AND accepted_at IS NULL
       RETURNING *`,
      [revokedBy, id]
    );
    const updated = result.rows[0];
    if (!updated) throw new AppError(409, 'This invitation was already accepted');

    await client.query('COMMIT');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Unlocked, read-only lookup — used only by GET /auth/invitations/:token
// (getInvitationInfo), which never mutates anything. Do NOT use this to gate
// a mutation; use lockInvitationByRawTokenForUpdate() below inside a
// transaction instead.
export async function findInvitationByRawToken(rawToken: string): Promise<InvitationRow | null> {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const result = await pool.query<InvitationRow>('SELECT * FROM employee_invitations WHERE token_hash = $1', [tokenHash]);
  return result.rows[0] ?? null;
}

// The race-safe counterpart of findInvitationByRawToken(), for use inside
// acceptInvitation()'s own transaction immediately before the accept
// mutation. Locks the row so a second concurrent accept of the same token
// (or a resend/revoke racing this accept) blocks until this transaction
// commits or rolls back, then re-reads a status that already reflects the
// outcome — a revoked, expired, accepted, or superseded token can never
// succeed twice.
export async function lockInvitationByRawTokenForUpdate(
  client: Pick<PoolClient, 'query'>,
  rawToken: string
): Promise<InvitationRow | null> {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const result = await client.query<InvitationRow>('SELECT * FROM employee_invitations WHERE token_hash = $1 FOR UPDATE', [tokenHash]);
  return result.rows[0] ?? null;
}

// Decision 10: link the accepted account to a pre-existing employees record
// with the same normalized email in this company (if one exists and isn't
// already linked to a user) instead of creating a duplicate. Never
// overwrites that employee's existing name/fields — linking is additive.
export async function findUnlinkedEmployeeByEmail(client: Pick<PoolClient, 'query'>, companyId: string, email: string): Promise<{ id: string } | null> {
  const result = await client.query<{ id: string }>(
    `SELECT e.id FROM employees e
     WHERE e.company_id = $1 AND lower(e.email) = $2
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.employee_id = e.id)
     ORDER BY e.created_at ASC
     LIMIT 1`,
    [companyId, email]
  );
  return result.rows[0] ?? null;
}

export function assertInvitableRole(inviterRole: string, targetRole: string): asserts targetRole is InvitableRole {
  const allowed = rolesInvitableBy(inviterRole);
  if (!allowed.includes(targetRole as InvitableRole)) {
    throw new AppError(403, 'You are not allowed to invite this role');
  }
}
