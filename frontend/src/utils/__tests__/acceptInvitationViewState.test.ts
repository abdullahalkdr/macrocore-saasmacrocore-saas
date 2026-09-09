import { describe, it, expect } from 'vitest';
import { deriveAcceptInvitationViewState } from '../acceptInvitationViewState';

// ---------------------------------------------------------------------------
// deriveAcceptInvitationViewState — live-QA fix (2026-09-09): a revoked
// English invitation rendered its terminal-state banner in Arabic, because
// the language was only ever read inside the `valid: true` (pending)
// branch. The rule under test: if an invitation record exists at all — for
// EVERY status, not just pending — its own language is used. Only a
// completely unknown token (no invitation row, reason: 'invalid') has no
// language to give and falls back to the caller's default.
// ---------------------------------------------------------------------------
describe('deriveAcceptInvitationViewState', () => {
  it('a pending (valid: true) English invitation renders in English', () => {
    const view = deriveAcceptInvitationViewState(
      { valid: true, email: 'a@b.com', full_name: 'A', company_name: 'Acme', preferred_language: 'en' },
      'ar'
    );
    expect(view.pageLang).toBe('en');
    expect(view.state).toBe('ready');
  });

  it('a pending Arabic invitation renders in Arabic', () => {
    const view = deriveAcceptInvitationViewState({ valid: true, email: 'a@b.com', preferred_language: 'ar' }, 'ar');
    expect(view.pageLang).toBe('ar');
    expect(view.state).toBe('ready');
  });

  it('an ACCEPTED English invitation still renders in English (regression)', () => {
    const view = deriveAcceptInvitationViewState({ valid: false, reason: 'accepted', preferred_language: 'en' }, 'ar');
    expect(view.pageLang).toBe('en');
    expect(view.state).toBe('accepted');
  });

  it('a REVOKED English invitation still renders in English (regression — the exact reported bug)', () => {
    const view = deriveAcceptInvitationViewState({ valid: false, reason: 'revoked', preferred_language: 'en' }, 'ar');
    expect(view.pageLang).toBe('en');
    expect(view.state).toBe('revoked');
  });

  it('an EXPIRED English invitation still renders in English (regression)', () => {
    const view = deriveAcceptInvitationViewState({ valid: false, reason: 'expired', preferred_language: 'en' }, 'ar');
    expect(view.pageLang).toBe('en');
    expect(view.state).toBe('expired');
  });

  it('a REVOKED Arabic invitation renders in Arabic (not just the English direction of the bug)', () => {
    const view = deriveAcceptInvitationViewState({ valid: false, reason: 'revoked', preferred_language: 'ar' }, 'en');
    expect(view.pageLang).toBe('ar');
    expect(view.state).toBe('revoked');
  });

  it('a genuinely unknown token (no invitation row — reason: invalid, no preferred_language) falls back to the caller default', () => {
    const view = deriveAcceptInvitationViewState({ valid: false, reason: 'invalid' }, 'ar');
    expect(view.pageLang).toBe('ar');
    expect(view.state).toBe('invalid');
  });

  it('a missing/garbage preferred_language value falls back to the caller default rather than crashing or defaulting silently to a fixed language', () => {
    const view = deriveAcceptInvitationViewState({ valid: false, reason: 'expired', preferred_language: undefined }, 'en');
    expect(view.pageLang).toBe('en');
  });

  it('defaults reason to "invalid" when the response omits it entirely', () => {
    const view = deriveAcceptInvitationViewState({ valid: false }, 'ar');
    expect(view.state).toBe('invalid');
  });

  it('carries through email/full_name/company_name only on the ready (valid) path', () => {
    const ready = deriveAcceptInvitationViewState(
      { valid: true, email: 'x@y.com', full_name: 'X Y', company_name: 'Co' },
      'ar'
    );
    expect(ready).toMatchObject({ email: 'x@y.com', fullName: 'X Y', companyName: 'Co' });

    const revoked = deriveAcceptInvitationViewState({ valid: false, reason: 'revoked', preferred_language: 'en' }, 'ar');
    expect(revoked).toMatchObject({ email: '', fullName: '', companyName: null });
  });
});
