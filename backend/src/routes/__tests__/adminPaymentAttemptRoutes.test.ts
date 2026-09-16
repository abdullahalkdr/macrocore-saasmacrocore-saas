import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response as ExpressResponse } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createPaymentAttempt: vi.fn((_req: Request, res: ExpressResponse) => res.status(204).end()),
  listPaymentAttempts: vi.fn((_req: Request, res: ExpressResponse) => res.status(204).end()),
  markPaymentAttemptFailed: vi.fn((_req: Request, res: ExpressResponse) => res.status(204).end()),
}));

vi.mock('../../controllers/admin.controller', () => ({
  listCompanies: vi.fn(),
  updateCompany: vi.fn(),
  listSubscriptions: vi.fn(),
  listInvoices: vi.fn(),
  stats: vi.fn(),
  activateSubscription: vi.fn(),
  getCompanySubscription: vi.fn(),
  createSubscriptionInvoice: vi.fn(),
  createPaymentAttempt: mocks.createPaymentAttempt,
  listPaymentAttempts: mocks.listPaymentAttempts,
  markPaymentAttemptFailed: mocks.markPaymentAttemptFailed,
}));

import adminRoutes from '../admin.routes';
import { errorHandler } from '../../middleware/errorHandler';

let server: Server | undefined;

async function request(path: string, method: 'GET' | 'POST', adminKey?: string): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  app.use(errorHandler);

  const activeServer = app.listen(0, '127.0.0.1');
  server = activeServer;
  await new Promise<void>((resolve) => activeServer.once('listening', resolve));
  const { port } = activeServer.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: adminKey ? { 'x-admin-key': adminKey } : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_API_KEY = 'b5-test-admin-key';
});

afterEach(async () => {
  delete process.env.ADMIN_API_KEY;
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
    server = undefined;
  }
});

describe('B5 Platform Admin route authorization', () => {
  it.each([
    ['POST', '/api/admin/invoices/00000000-0000-0000-0000-000000000001/payment-attempts'],
    ['GET', '/api/admin/invoices/00000000-0000-0000-0000-000000000001/payment-attempts'],
    ['POST', '/api/admin/payment-attempts/00000000-0000-0000-0000-000000000002/mark-failed'],
  ] as const)('rejects an unauthenticated %s %s request before its controller runs', async (method, path) => {
    const response = await request(path, method);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid admin key' });
    expect(mocks.createPaymentAttempt).not.toHaveBeenCalled();
    expect(mocks.listPaymentAttempts).not.toHaveBeenCalled();
    expect(mocks.markPaymentAttemptFailed).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/api/admin/invoices/00000000-0000-0000-0000-000000000001/payment-attempts', mocks.createPaymentAttempt],
    ['GET', '/api/admin/invoices/00000000-0000-0000-0000-000000000001/payment-attempts', mocks.listPaymentAttempts],
    ['POST', '/api/admin/payment-attempts/00000000-0000-0000-0000-000000000002/mark-failed', mocks.markPaymentAttemptFailed],
  ] as const)('allows an authenticated %s %s request to reach its controller', async (method, path, handler) => {
    const response = await request(path, method, 'b5-test-admin-key');
    expect(response.status).toBe(204);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
