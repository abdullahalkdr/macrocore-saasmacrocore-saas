import { describe, expect, it } from 'vitest';
import { resolveAccountDeepLinkSection } from '../accountDeepLink';

describe('resolveAccountDeepLinkSection', () => {
  it('keeps the existing profile deep link available to every authenticated role', () => {
    expect(resolveAccountDeepLinkSection('profile', false)).toBe('profile');
    expect(resolveAccountDeepLinkSection('profile', true)).toBe('profile');
  });

  it('allows the billing deep link only for tenant admins', () => {
    expect(resolveAccountDeepLinkSection('billing', true)).toBe('billing');
    expect(resolveAccountDeepLinkSection('billing', false)).toBeNull();
  });

  it('rejects crafted deep links to every other account section', () => {
    for (const section of ['company', 'users', 'setup', 'customizations', 'developer', 'emailDelivery']) {
      expect(resolveAccountDeepLinkSection(section, true)).toBeNull();
      expect(resolveAccountDeepLinkSection(section, false)).toBeNull();
    }
  });

  it('safely ignores missing and unknown section values', () => {
    expect(resolveAccountDeepLinkSection(null, true)).toBeNull();
    expect(resolveAccountDeepLinkSection('not-a-real-section', true)).toBeNull();
  });
});
