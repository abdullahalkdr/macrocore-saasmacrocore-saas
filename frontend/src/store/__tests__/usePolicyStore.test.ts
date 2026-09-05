import { describe, it, expect, vi, beforeEach } from 'vitest';

// Policy Gate pilot (MIGRATION_074/075) — cross-user isolation fix (2026-09).
//
// Mocked at the module boundary usePolicyStore.ts actually imports (api/client), not by
// stubbing fetch — the point of this test is the STORE's own logout/login race
// handling, not the HTTP layer underneath it.
const getMock = vi.fn();
vi.mock('../../api/client', () => ({
  get: (...args: unknown[]) => getMock(...args),
  post: vi.fn(),
  patch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { usePolicyStore, PendingPermissionGrant } from '../usePolicyStore';
import { useAuthStore } from '../authStore';

// A promise this test can resolve on its own schedule, to simulate a slow
// /permissions/my-pending-grants response that outlives a logout or a fresh login.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeGrant(label: string): PendingPermissionGrant {
  return {
    id: `grant-${label}`,
    permission_key: 'view_audit_log',
    policy_id: `policy-${label}`,
    name: `سياسة ${label}`,
    name_en: `Policy ${label}`,
    content: `Confidential content belonging to ${label}`,
    content_en: `Confidential content belonging to ${label}`,
    version: 1,
  };
}

describe('usePolicyStore pending-grant cross-user isolation', () => {
  beforeEach(() => {
    getMock.mockReset();
    usePolicyStore.setState({ pendingGrants: [], pendingGrantsLoading: false });
    useAuthStore.setState({ token: null, user: null, company: null });
  });

  it('never applies a fetchPendingGrants response that resolves after logout', async () => {
    const userA = deferred<{ pending: PendingPermissionGrant[] }>();
    getMock.mockReturnValueOnce(userA.promise);

    // User A's ProfileSection mounts and requests their pending grants — the request
    // is still in flight when the rest of this test runs.
    const inFlight = usePolicyStore.getState().fetchPendingGrants();
    expect(usePolicyStore.getState().pendingGrantsLoading).toBe(true);

    // User A logs out via the real authStore action — this is the actual boundary the
    // app hits, not a direct call into usePolicyStore's internals.
    useAuthStore.getState().logout();

    // The store must already be clear the instant logout() returns, before user A's
    // slow request has resolved at all.
    expect(usePolicyStore.getState().pendingGrants).toEqual([]);
    expect(usePolicyStore.getState().pendingGrantsLoading).toBe(false);

    // User A's response finally arrives, carrying user A's own policy content.
    userA.resolve({ pending: [fakeGrant('A')] });
    await inFlight;

    // It must never land — logging out already invalidated this in-flight request.
    expect(usePolicyStore.getState().pendingGrants).toEqual([]);
    expect(usePolicyStore.getState().pendingGrantsLoading).toBe(false);
  });

  it('never applies a fetchPendingGrants response started before a login as a different user', async () => {
    const userA = deferred<{ pending: PendingPermissionGrant[] }>();
    getMock.mockReturnValueOnce(userA.promise);

    const inFlight = usePolicyStore.getState().fetchPendingGrants();

    // The same tab authenticates as a different user — e.g. a session that had already
    // expired, so LoginPage calls setAuth() directly without an explicit prior
    // logout(). This is the OTHER identity-change boundary (see authStore.ts).
    useAuthStore.getState().setAuth('token-b', {
      id: 'user-b',
      email: 'b@example.com',
      full_name: 'User B',
      role: 'employee',
      company_id: 'company-b',
    });

    expect(usePolicyStore.getState().pendingGrants).toEqual([]);

    // Now user B's own ProfileSection mount fires its own, faster request.
    getMock.mockResolvedValueOnce({ pending: [fakeGrant('B')] });
    await usePolicyStore.getState().fetchPendingGrants();
    expect(usePolicyStore.getState().pendingGrants).toEqual([fakeGrant('B')]);

    // User A's stale response arrives last of all.
    userA.resolve({ pending: [fakeGrant('A')] });
    await inFlight;

    // User B's already-loaded, already-correct data must survive untouched — user A's
    // content must never overwrite it.
    expect(usePolicyStore.getState().pendingGrants).toEqual([fakeGrant('B')]);
  });

  it('still populates pendingGrants normally when no identity change occurs', async () => {
    getMock.mockResolvedValueOnce({ pending: [fakeGrant('normal')] });
    await usePolicyStore.getState().fetchPendingGrants();
    expect(usePolicyStore.getState().pendingGrants).toEqual([fakeGrant('normal')]);
    expect(usePolicyStore.getState().pendingGrantsLoading).toBe(false);
  });
});
