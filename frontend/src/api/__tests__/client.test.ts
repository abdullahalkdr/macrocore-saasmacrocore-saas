import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openModal = vi.fn();
vi.mock('../../store/upgradeModalStore', () => ({
  useUpgradeModalStore: { getState: () => ({ openModal }) },
}));

import { ApiError, get, post, shouldOpenUpgradeModal } from '../client';

function planGated() {
  return Promise.resolve(
    new Response(JSON.stringify({ error: 'Leave requests requires the Silver plan or higher', code: 'PLAN_UPGRADE_REQUIRED' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

// The dynamic import in client.ts resolves on a later tick.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('shouldOpenUpgradeModal', () => {
  it('opens only for a user-initiated 403 PLAN_UPGRADE_REQUIRED', () => {
    expect(shouldOpenUpgradeModal(403, 'PLAN_UPGRADE_REQUIRED')).toBe(true);
    expect(shouldOpenUpgradeModal(403, 'PLAN_UPGRADE_REQUIRED', {})).toBe(true);
    expect(shouldOpenUpgradeModal(403, 'PLAN_UPGRADE_REQUIRED', { background: true })).toBe(false);
    expect(shouldOpenUpgradeModal(403, 'FORBIDDEN')).toBe(false);
    expect(shouldOpenUpgradeModal(402, 'PLAN_UPGRADE_REQUIRED')).toBe(false);
  });
});

describe('request interceptor — upgrade modal', () => {
  beforeEach(() => {
    openModal.mockClear();
    vi.stubGlobal('fetch', vi.fn(planGated));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a background GET that hits a plan gate does NOT pop the modal, but still rejects', async () => {
    await expect(get('/leave-requests?status=pending', { background: true })).rejects.toBeInstanceOf(ApiError);
    await flush();
    expect(openModal).not.toHaveBeenCalled();
  });

  it('a user-initiated GET (default) still pops the modal', async () => {
    await expect(get('/leave-requests')).rejects.toMatchObject({ status: 403, code: 'PLAN_UPGRADE_REQUIRED' });
    await flush();
    expect(openModal).toHaveBeenCalledTimes(1);
  });

  it('a user action (POST) still pops the modal', async () => {
    await expect(post('/leave-requests', { days: 1 })).rejects.toBeInstanceOf(ApiError);
    await flush();
    expect(openModal).toHaveBeenCalledTimes(1);
  });
});
