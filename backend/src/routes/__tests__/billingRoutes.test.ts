import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response as ExpressResponse } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Stage B7 — /api/billing routing and authorization (design v3 §7, D7).
// Uses the REAL app (app.ts) with the REAL requireAuth / requireUserSession /
// requireRole chain and mocked billing controllers + pool, so it proves:
//   * the mount is NOT behind requireActiveSubscription (an expired trial can
//     still reach the billing endpoints),
//   * API keys are rejected on ALL THREE purchase routes,
//   * non-admins are rejected on purchase routes, while GET /plans is open to
//     any authenticated identity.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  getPlans: vi.fn((_req: Request, res: ExpressResponse) => res.status(200).json({ ok: 'plans' })),
  createPurchase: vi.fn((_req: Request, res: ExpressResponse) => res.status(201).json({ ok: 'create' })),
  getPurchase: vi.fn((_req: Request, res: ExpressResponse) => res.status(200).json({ ok: 'get' })),
  startPurchaseCheckout: vi.fn((_req: Request, res: ExpressResponse) => res.status(200).json({ ok: 'checkout' })),
}));

vi.mock('../../db/pool', () => ({ pool: { query: mocks.poolQuery, connect: vi.fn() } }));
vi.mock('../../controllers/billing.controller', () => ({
  getPlans: mocks.getPlans,
  createPurchase: mocks.createPurchase,
  getPurchase: mocks.getPurchase,
  startPurchaseCheckout: mocks.startPurchaseCheckout,
}));

import { app } from '../../app';
import { signToken } from '../../utils/jwt';

let server: Server | undefined;

async function call(path: string, method: 'GET' | 'POST', headers: Record<string, string> = {}): Promise<Response> {
  const activeServer = app.listen(0, '127.0.0.1');
  server = activeServer;
  await new Promise<void>((resolve) => activeServer.once('listening', resolve));
  const { port } = activeServer.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'POST' ? '{}' : undefined,
  });
}

const adminJwt = () => `Bearer ${signToken({ userId: 'user-admin', companyId: 'company-1', role: 'admin' })}`;
const employeeJwt = () => `Bearer ${signToken({ userId: 'user-emp', companyId: 'company-1', role: 'employee' })}`;
const PURCHASE_ID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
  // Any company lookup (requireActiveSubscription would do one) returns an
  // EXPIRED trial — so reaching a controller proves the gate is not mounted.
  mocks.poolQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM api_keys')) return { rows: [{ id: 'key-1', company_id: 'company-1', created_by: 'user-admin' }] };
    if (sql.includes('UPDATE api_keys')) return { rows: [] };
    if (sql.includes('FROM companies')) return { rows: [{ plan: 'trial', subscription_status: 'trial', trial_end_date: '2020-01-01T00:00:00Z' }] };
    return { rows: [] };
  });
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe('/api/billing — authentication and mounting', () => {
  it('requires authentication (401 without a token)', async () => {
    const res = await call('/api/billing/plans', 'GET');
    expect(res.status).toBe(401);
    expect(mocks.getPlans).not.toHaveBeenCalled();
  });

  it('is NOT behind requireActiveSubscription: an expired trial admin reaches every billing controller', async () => {
    expect((await call('/api/billing/plans', 'GET', { authorization: adminJwt() })).status).toBe(200);
    expect((await call('/api/billing/purchases', 'POST', { authorization: adminJwt() })).status).toBe(201);
    expect((await call(`/api/billing/purchases/${PURCHASE_ID}`, 'GET', { authorization: adminJwt() })).status).toBe(200);
    expect((await call(`/api/billing/purchases/${PURCHASE_ID}/checkout`, 'POST', { authorization: adminJwt() })).status).toBe(200);
  });
});

describe('/api/billing — authorization', () => {
  it('GET /plans is available to any authenticated identity (employee JWT and API key)', async () => {
    expect((await call('/api/billing/plans', 'GET', { authorization: employeeJwt() })).status).toBe(200);
    expect((await call('/api/billing/plans', 'GET', { 'x-api-key': 'mk_live_test' })).status).toBe(200);
    expect(mocks.getPlans).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['POST', '/api/billing/purchases'],
    ['GET', `/api/billing/purchases/${PURCHASE_ID}`],
    ['POST', `/api/billing/purchases/${PURCHASE_ID}/checkout`],
  ] as const)('%s %s rejects an API key with 403 USER_SESSION_REQUIRED', async (method, path) => {
    const res = await call(path, method, { 'x-api-key': 'mk_live_test' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'USER_SESSION_REQUIRED' });
    expect(mocks.createPurchase).not.toHaveBeenCalled();
    expect(mocks.getPurchase).not.toHaveBeenCalled();
    expect(mocks.startPurchaseCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/api/billing/purchases'],
    ['GET', `/api/billing/purchases/${PURCHASE_ID}`],
    ['POST', `/api/billing/purchases/${PURCHASE_ID}/checkout`],
  ] as const)('%s %s rejects a non-admin user session with 403', async (method, path) => {
    const res = await call(path, method, { authorization: employeeJwt() });
    expect(res.status).toBe(403);
  });
});
