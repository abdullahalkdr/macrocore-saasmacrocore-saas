import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response as ExpressResponse } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getHostedCheckoutSession: vi.fn((_req: Request, res: ExpressResponse) => res.status(204).end()),
  resolveHostedCheckoutSession: vi.fn((_req: Request, res: ExpressResponse) => res.status(204).end()),
}));

vi.mock('../../controllers/simulatedCheckout.controller', () => ({
  getHostedCheckoutSession: mocks.getHostedCheckoutSession,
  resolveHostedCheckoutSession: mocks.resolveHostedCheckoutSession,
}));

import simulatedCheckoutRoutes from '../simulatedCheckout.routes';

let server: Server | undefined;

async function request(path: string, method: 'GET' | 'POST' = 'GET'): Promise<Response> {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/simulated-checkout', simulatedCheckoutRoutes);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
  }
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}${path}`, { method });
}

afterEach(async () => {
  vi.clearAllMocks();
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
    server = undefined;
  }
});

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('content-security-policy')).toBe("default-src 'self'; frame-ancestors 'none'");
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
}

describe('simulated checkout hosted route', () => {
  it('serves one Arabic RTL shell with external-only JS/CSS and all security headers', async () => {
    const response = await request('/simulated-checkout/');
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expectSecurityHeaders(response);
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('لن يتم خصم أي مبلغ حقيقي');
    expect(html).toContain('<link rel="stylesheet" href="/simulated-checkout/app.css">');
    expect(html).toContain('<script src="/simulated-checkout/app.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });

  it('serves same-origin JS/CSS assets with the expected content types and dark-mode styling', async () => {
    const jsResponse = await request('/simulated-checkout/app.js');
    const js = await jsResponse.text();
    expect(jsResponse.headers.get('content-type')).toContain('application/javascript');
    expectSecurityHeaders(jsResponse);
    expect(js).toContain('window.confirm');
    expect(js).toContain('if (resolving) return');

    const cssResponse = await request('/simulated-checkout/app.css');
    const css = await cssResponse.text();
    expect(cssResponse.headers.get('content-type')).toContain('text/css');
    expectSecurityHeaders(cssResponse);
    expect(css).toContain('--amber-500: #f59e0b');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });

  it.each([
    ['GET', '/simulated-checkout/api/session'],
    ['POST', '/simulated-checkout/api/resolve'],
  ] as const)('applies the same security headers to %s %s', async (method, path) => {
    const response = await request(path, method);
    expect(response.status).toBe(204);
    expectSecurityHeaders(response);
  });
});
