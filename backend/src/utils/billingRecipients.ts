import { pool } from '../db/pool';
import type { EmailLang, Queryable } from './email';

// ============================================================================
// Billing recipient resolution — Chat 4B, Stage B4A. See
// claude/chat4b-b4a-immediate-subscription-invoice-emails-2026-09-15.md
// (project doc) for the full brief.
//
// There is no Billing Contact model in this codebase — this file does not
// invent one. A tenant's billing recipients are exactly: users with the
// event's own company_id, role = 'admin', status = 'active', and a
// valid/trimmed/non-empty email. This is intentionally narrower than
// helpdeskRecipients.ts's ladder (no department-manager/escalation-role/
// admin-or-manager fallback) — the brief's recipient policy stops at "active
// admins in this tenant", full stop.
//
// Cross-tenant safety: the query below is scoped by company_id in the WHERE
// clause, same pattern as helpdeskRecipients.ts's resolveEligibleCandidate()
// — a user from a different tenant simply matches no row, there is no
// separate "is this the right tenant" check to forget.
//
// Post-commit only, like every other recipient resolver in this codebase
// (helpdeskRecipients.ts included): every call site (auth.controller.ts's
// register(), admin.controller.ts's activateSubscription()/
// createSubscriptionInvoice()) calls this AFTER its own transaction has
// already committed, using the plain `pool` import below — never inside an
// open business transaction. This is a deliberate, reviewed design decision
// for Stage B4A (see claude/chat4b-b4a-immediate-subscription-invoice-emails-2026-09-15.md,
// project doc): the company/admin/trial (or subscription/invoice) row is
// durably committed before this ever runs, so a plain `pool.query()` always
// sees it — there is no uncommitted-visibility problem to solve here.
// ============================================================================

export interface ResolvedBillingRecipient {
  userId: string;
  email: string;
  preferredLanguage: EmailLang;
  companyTimezone: string;
}

interface BillingCandidateRow {
  id: string;
  email: string;
  preferred_language: string | null;
  company_timezone: string | null;
}

// Deliberately permissive shape check, not a full RFC 5322 validator — this
// only needs to reject obviously-unusable stored values (blank, no '@', no
// domain dot), the same bar the brief's "valid/trimmed/non-empty email"
// wording asks for. users.email already has a NOT NULL + UNIQUE constraint
// at the DB level (DATABASE_SCHEMA.sql), so this is a defensive second check,
// not the only one.
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isUsableEmail(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_LIKE.test(value.trim());
}

// Unsupported/missing preferred_language falls back to Arabic — the brief's
// explicit default — rather than to whatever the DB's own default happens to
// be today, so this stays correct even if that default ever changes.
function resolveLang(raw: string | null): EmailLang {
  return raw === 'en' ? 'en' : 'ar';
}

/**
 * Resolves the active tenant admins eligible to receive a billing email for
 * `companyId`. Deduplicates by normalized (lower-cased, trimmed) email —
 * per the brief's recipient policy — while keeping one stable userId per
 * normalized email (the first row encountered) for the caller's dedup_key.
 * Never returns a recipient from a different company: the query itself is
 * scoped by company_id, so there is nothing here to bypass.
 *
 * Chat 4C, Stage B4B — additive `queryable` parameter, defaulting to the
 * plain `pool` (byte-identical behavior for every existing call site above,
 * which are all still strictly post-commit). trialLifecycleEmails.ts's own
 * per-company transaction (design v8 §2.2) is the only caller that ever
 * passes its own open transaction's client instead — so it resolves
 * recipients using the SAME client that holds its `companies FOR UPDATE`
 * lock, rather than a second, separate `pool` connection.
 */
export async function resolveBillingRecipients(companyId: string, queryable: Queryable = pool): Promise<ResolvedBillingRecipient[]> {
  const result = await queryable.query<BillingCandidateRow>(
    `SELECT u.id, u.email, u.preferred_language, c.timezone AS company_timezone
     FROM users u
     JOIN companies c ON c.id = u.company_id
     WHERE u.company_id = $1 AND u.role = 'admin' AND u.status = 'active'
     ORDER BY u.created_at ASC, u.id ASC`,
    [companyId]
  );

  const seenEmails = new Set<string>();
  const out: ResolvedBillingRecipient[] = [];
  for (const row of result.rows) {
    if (!isUsableEmail(row.email)) continue;
    const trimmedEmail = row.email.trim();
    const normalized = trimmedEmail.toLowerCase();
    if (seenEmails.has(normalized)) continue;
    seenEmails.add(normalized);
    out.push({
      userId: row.id,
      email: trimmedEmail,
      preferredLanguage: resolveLang(row.preferred_language),
      companyTimezone: row.company_timezone?.trim() || 'Asia/Kuwait',
    });
  }
  return out;
}
