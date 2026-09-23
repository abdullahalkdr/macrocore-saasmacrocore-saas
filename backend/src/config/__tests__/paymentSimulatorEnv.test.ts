import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const BASE_ENV = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/testdb',
  JWT_SECRET: 'a'.repeat(32),
  NODE_ENV: 'development',
};

const STRONG_SECRET = Buffer.from('a'.repeat(32)).toString('base64url');

async function loadEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  const originalEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('PAYMENT_SIMULATOR_') || key === 'ENABLE_PAYMENT_SIMULATOR') {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(BASE_ENV)) {
    process.env[key] = value;
  }
  // Assign field-by-field rather than via Object.assign: process.env coerces
  // an assigned `undefined` to the literal string "undefined" instead of
  // leaving the key absent, which would silently defeat every "unset" test
  // case below.
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    const mod = await import('../env');
    return mod;
  } finally {
    process.env = originalEnv;
  }
}

describe('payment simulator environment validation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  describe('isStrongSimulatorSecret (via PAYMENT_SIMULATOR_OPERATIONAL)', () => {
    it('is not operational when the secret is empty', async () => {
      const mod = await loadEnv({
        ENABLE_PAYMENT_SIMULATOR: 'true',
        PAYMENT_SIMULATOR_TOKEN_SECRET: '',
        PAYMENT_SIMULATOR_PUBLIC_BASE_URL: 'https://pay.example.com',
      });
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('is not operational when the secret decodes to fewer than 32 raw bytes', async () => {
      const shortSecret = Buffer.from('short').toString('base64url');
      const mod = await loadEnv({
        ENABLE_PAYMENT_SIMULATOR: 'true',
        PAYMENT_SIMULATOR_TOKEN_SECRET: shortSecret,
        PAYMENT_SIMULATOR_PUBLIC_BASE_URL: 'https://pay.example.com',
      });
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('is not operational when the secret contains characters outside the base64url alphabet', async () => {
      const mod = await loadEnv({
        ENABLE_PAYMENT_SIMULATOR: 'true',
        PAYMENT_SIMULATOR_TOKEN_SECRET: `${'a'.repeat(40)}+/=`,
        PAYMENT_SIMULATOR_PUBLIC_BASE_URL: 'https://pay.example.com',
      });
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('is not operational when the value does not round-trip to itself (non-canonical encoding)', async () => {
      // 45 'a' characters: valid base64url alphabet, decodes to 33 raw bytes
      // (>= the 32-byte floor), but re-encoding those 33 bytes produces a
      // 44-character string, not the original 45 — a non-canonical encoding
      // that must be rejected by the round-trip check specifically, not by
      // the length check (verified deterministically below, independent of
      // the module under test, so this fixture can't silently stop
      // exercising the round-trip branch if Node's base64url behavior ever
      // changes).
      const nonCanonical = 'a'.repeat(45);
      const decoded = Buffer.from(nonCanonical, 'base64url');
      expect(decoded.length).toBeGreaterThanOrEqual(32);
      expect(decoded.toString('base64url')).not.toBe(nonCanonical);

      const mod = await loadEnv({
        ENABLE_PAYMENT_SIMULATOR: 'true',
        PAYMENT_SIMULATOR_TOKEN_SECRET: nonCanonical,
        PAYMENT_SIMULATOR_PUBLIC_BASE_URL: 'https://pay.example.com',
      });
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('is operational with a valid strong secret, valid base URL, and enabled flag', async () => {
      const mod = await loadEnv({
        ENABLE_PAYMENT_SIMULATOR: 'true',
        PAYMENT_SIMULATOR_TOKEN_SECRET: STRONG_SECRET,
        PAYMENT_SIMULATOR_PUBLIC_BASE_URL: 'https://pay.example.com',
      });
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(true);
    });

    it('is not operational when ENABLE_PAYMENT_SIMULATOR is unset', async () => {
      const mod = await loadEnv({
        PAYMENT_SIMULATOR_TOKEN_SECRET: STRONG_SECRET,
        PAYMENT_SIMULATOR_PUBLIC_BASE_URL: 'https://pay.example.com',
      });
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('is not operational when ENABLE_PAYMENT_SIMULATOR is explicitly false', async () => {
      const mod = await loadEnv({
        ENABLE_PAYMENT_SIMULATOR: 'false',
        PAYMENT_SIMULATOR_TOKEN_SECRET: STRONG_SECRET,
        PAYMENT_SIMULATOR_PUBLIC_BASE_URL: 'https://pay.example.com',
      });
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });
  });

  describe('validateSimulatorBaseUrl (via PAYMENT_SIMULATOR_OPERATIONAL / PAYMENT_SIMULATOR_BASE_URL)', () => {
    const enabledWith = (url: string, extra: Record<string, string> = {}) => ({
      ENABLE_PAYMENT_SIMULATOR: 'true',
      PAYMENT_SIMULATOR_TOKEN_SECRET: STRONG_SECRET,
      PAYMENT_SIMULATOR_PUBLIC_BASE_URL: url,
      ...extra,
    });

    it('rejects a file: protocol', async () => {
      const mod = await loadEnv(enabledWith('file:///etc/passwd'));
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('rejects a javascript: protocol', async () => {
      const mod = await loadEnv(enabledWith('javascript:alert(1)'));
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('rejects an ftp: protocol', async () => {
      const mod = await loadEnv(enabledWith('ftp://pay.example.com'));
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('rejects a value that does not parse as a URL at all', async () => {
      const mod = await loadEnv(enabledWith('not a url'));
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('rejects http: in production', async () => {
      const mod = await loadEnv({
        ...enabledWith('http://pay.example.com'),
        NODE_ENV: 'production',
      });
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('accepts http: in development', async () => {
      const mod = await loadEnv({
        ...enabledWith('http://pay.example.com'),
        NODE_ENV: 'development',
      });
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(true);
    });

    it('accepts https: in production', async () => {
      const mod = await loadEnv({
        ...enabledWith('https://pay.example.com'),
        NODE_ENV: 'production',
      });
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(true);
    });

    it('rejects a URL containing embedded credentials', async () => {
      const mod = await loadEnv(enabledWith('https://user:pass@pay.example.com'));
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('rejects a URL containing a query string', async () => {
      const mod = await loadEnv(enabledWith('https://pay.example.com/?foo=bar'));
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('rejects a URL containing a fragment', async () => {
      const mod = await loadEnv(enabledWith('https://pay.example.com/#frag'));
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('rejects a URL with a non-root pathname', async () => {
      const mod = await loadEnv(enabledWith('https://pay.example.com/checkout'));
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(false);
    });

    it('accepts a bare origin with no trailing slash and normalizes via .origin', async () => {
      const mod = await loadEnv(enabledWith('https://pay.example.com'));
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(true);
      expect(mod.PAYMENT_SIMULATOR_BASE_URL).toBe('https://pay.example.com');
    });

    it('accepts a root path with a trailing slash, normalized via .origin', async () => {
      const mod = await loadEnv(enabledWith('https://pay.example.com/'));
      expect(mod.PAYMENT_SIMULATOR_OPERATIONAL).toBe(true);
      expect(mod.PAYMENT_SIMULATOR_BASE_URL).toBe('https://pay.example.com');
    });
  });

  describe('parseCompanyIdAllowlist (via env.PAYMENT_SIMULATOR_COMPANY_IDS)', () => {
    const uuid1 = '11111111-1111-1111-1111-111111111111';
    const uuid2 = '22222222-2222-2222-2222-222222222222';

    it('parses a valid comma-separated list of UUIDs', async () => {
      const mod = await loadEnv({
        PAYMENT_SIMULATOR_COMPANY_IDS: `${uuid1},${uuid2}`,
      });
      expect(mod.env.PAYMENT_SIMULATOR_COMPANY_IDS).toEqual([uuid1, uuid2]);
    });

    it('trims whitespace around entries', async () => {
      const mod = await loadEnv({
        PAYMENT_SIMULATOR_COMPANY_IDS: ` ${uuid1} , ${uuid2} `,
      });
      expect(mod.env.PAYMENT_SIMULATOR_COMPANY_IDS).toEqual([uuid1, uuid2]);
    });

    it('fails closed to an empty list when any entry is malformed', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mod = await loadEnv({
        PAYMENT_SIMULATOR_COMPANY_IDS: `${uuid1},not-a-uuid`,
      });
      expect(mod.env.PAYMENT_SIMULATOR_COMPANY_IDS).toEqual([]);
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('produces an empty list with no error when the value is unset', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mod = await loadEnv({
        PAYMENT_SIMULATOR_COMPANY_IDS: undefined,
      });
      expect(mod.env.PAYMENT_SIMULATOR_COMPANY_IDS).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('produces an empty list with no error when the value is an empty string', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mod = await loadEnv({
        PAYMENT_SIMULATOR_COMPANY_IDS: '',
      });
      expect(mod.env.PAYMENT_SIMULATOR_COMPANY_IDS).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});
