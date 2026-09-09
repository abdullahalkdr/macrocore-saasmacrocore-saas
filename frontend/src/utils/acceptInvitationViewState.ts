// Pure view-state derivation for AcceptInvitationPage.tsx, extracted so the
// language decision can be unit-tested directly (this repo's frontend test
// suite has no jsdom/React-rendering setup — see userRoleGuards.ts for the
// same pattern).
//
// Live-QA fix (2026-09-09): an English-language invitation that had been
// revoked rendered its "revoked" banner in Arabic. Root cause was two
// layered bugs — GET /auth/invitations/:token only returned
// preferred_language inside its `valid: true` (pending) branch, and the
// page only read `res.preferred_language` inside its own `if (res.valid)`
// branch, so a resolved (accepted/revoked/expired) invitation never had a
// language to apply on either side. Both are fixed; this function is the
// frontend half, and its own rule is now load-bearing: the language is
// derived from the response FIRST, unconditionally, before any branch on
// `valid`/`reason`/status — so it can never again depend on which branch a
// given status happens to fall into. Only a truly unknown token (no
// invitation row at all — reason: 'invalid', so no preferred_language is
// even present on the response) falls back to the caller's default.
import { Lang } from '../store/langStore';

export type AcceptInvitationLoadState = 'ready' | 'invalid' | 'expired' | 'revoked' | 'accepted';

export interface InvitationInfoResponse {
  valid: boolean;
  reason?: 'invalid' | 'expired' | 'revoked' | 'accepted';
  email?: string;
  full_name?: string | null;
  role?: string;
  company_name?: string | null;
  // Present whenever an invitation row exists, regardless of its status —
  // see the getInvitationInfo backend comment for the same rule.
  preferred_language?: Lang;
}

export interface AcceptInvitationViewState {
  state: AcceptInvitationLoadState;
  pageLang: Lang;
  email: string;
  companyName: string | null;
  fullName: string;
}

export function deriveAcceptInvitationViewState(res: InvitationInfoResponse, defaultLang: Lang): AcceptInvitationViewState {
  // Applied unconditionally, before any branch below — this ordering IS the
  // fix. Any known language on the response wins; a missing/unrecognized
  // one (the only-truly-unknown-token case) falls back to defaultLang.
  const pageLang: Lang = res.preferred_language === 'en' || res.preferred_language === 'ar' ? res.preferred_language : defaultLang;

  if (!res.valid) {
    return { state: res.reason ?? 'invalid', pageLang, email: '', companyName: null, fullName: '' };
  }

  return {
    state: 'ready',
    pageLang,
    email: res.email ?? '',
    companyName: res.company_name ?? null,
    fullName: res.full_name ?? '',
  };
}
