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
// preferred_language (via getDictionary + local pageLang state), and must
// NOT depend on the ambient useT()/useLangStore or mutate
// document.documentElement, since that would leak into every other page
// and visitor.
// ---------------------------------------------------------------------------
describe('AcceptInvitationPage language source regression', () => {
  const source = fs.readFileSync(path.join(__dirname, '../AcceptInvitationPage.tsx'), 'utf-8');

  it('renders from getDictionary(pageLang), not the ambient useT() hook', () => {
    expect(source).toMatch(/getDictionary\(pageLang\)/);
    expect(source).not.toMatch(/useT\(\)/);
  });

  it('reads preferred_language from the invitation info response and never reads/writes the global language store\'s live state', () => {
    expect(source).toMatch(/preferred_language/);
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
