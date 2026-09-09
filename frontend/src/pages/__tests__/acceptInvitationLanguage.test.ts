import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getDictionary } from '../../i18n';

// ---------------------------------------------------------------------------
// getDictionary — the non-hook building block AcceptInvitationPage.tsx uses
// to render in the INVITATION's own language (decision 3), independent of
// the visitor's ambient site-wide language toggle (production review,
// 2026-09-09).
// ---------------------------------------------------------------------------
describe('getDictionary', () => {
  it('returns a distinct dictionary per language', () => {
    const en = getDictionary('en');
    const ar = getDictionary('ar');
    expect(en.acceptInvitation.invalidTitle).not.toBe(ar.acceptInvitation.invalidTitle);
    expect(en.acceptInvitation.checking).toBeTruthy();
    expect(ar.acceptInvitation.checking).toBeTruthy();
  });

  it('is a plain function of its input — same language in, same content out, with no dependency on any global/store state', () => {
    const first = getDictionary('ar');
    const second = getDictionary('ar');
    expect(first).toBe(second); // same dictionary object both times
  });
});

// ---------------------------------------------------------------------------
// Static source regression: this repo's frontend test suite has no
// jsdom/React-rendering setup (see the existing tests under
// src/pages/account/__tests__ and src/utils/__tests__, all pure-logic), so
// the actual page component is checked the same way backend/src/utils/
// __tests__/email.test.ts checks its own source for the 42P08 regression —
// reading the real file and asserting the properties that matter can't
// silently regress: the page must render from the invitation's own
// language (via getDictionary + local pageLang state, now derived through
// deriveAcceptInvitationViewState() — see acceptInvitationViewState.test.ts
// for the real behavioral coverage of that derivation), and must NOT depend
// on the ambient useT()/useLangStore or mutate document.documentElement,
// since that would leak into every other page and visitor.
// ---------------------------------------------------------------------------
describe('AcceptInvitationPage language source regression', () => {
  const source = fs.readFileSync(path.join(__dirname, '../AcceptInvitationPage.tsx'), 'utf-8');

  it('renders from getDictionary(pageLang), not the ambient useT() hook', () => {
    expect(source).toMatch(/getDictionary\(pageLang\)/);
    expect(source).not.toMatch(/useT\(\)/);
  });

  it('derives pageLang from the invitation info response via deriveAcceptInvitationViewState(), not inline logic, and never reads/writes the global language store\'s live state (live-QA fix, 2026-09-09: the language decision moved into one pure, independently-tested function so it can no longer depend on which valid/status branch a response falls into)', () => {
    expect(source).toMatch(/deriveAcceptInvitationViewState\(res,\s*'ar'\)/);
    // Importing the pure isRTL() helper and the Lang TYPE from the langStore
    // module is fine (and expected) — what must never appear is a call to
    // the useLangStore HOOK, which would couple this page to the visitor's
    // ambient site-wide toggle instead of the invitation's own language.
    expect(source).not.toMatch(/useLangStore\(/);
    expect(source).not.toMatch(/document\.documentElement/);
  });

  it('scopes dir/lang to this page’s own root element instead of the document', () => {
    expect(source).toMatch(/dir=\{isRTL\(pageLang\)/);
    expect(source).toMatch(/lang=\{pageLang\}/);
  });
});

// ---------------------------------------------------------------------------
// deriveAcceptInvitationViewState() source regression: the ordering
// guarantee itself — pageLang must be computed BEFORE the `if (!res.valid)`
// branch, not inside it or after it, since a branch-scoped read is exactly
// how the original bug happened (preferred_language was only read inside
// the `valid: true` case, so every non-pending status — accepted, revoked,
// expired — silently fell back to the page's default language).
// ---------------------------------------------------------------------------
describe('deriveAcceptInvitationViewState ordering source regression', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../utils/acceptInvitationViewState.ts'), 'utf-8');

  it('computes pageLang before branching on res.valid', () => {
    const pageLangIdx = source.indexOf('const pageLang');
    const branchIdx = source.indexOf('if (!res.valid)');
    expect(pageLangIdx).toBeGreaterThan(0);
    expect(branchIdx).toBeGreaterThan(pageLangIdx);
  });
});
