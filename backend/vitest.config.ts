import { defineConfig } from 'vitest/config';

// Test-only env vars — never real credentials. config/env.ts calls required()
// for DATABASE_URL/JWT_SECRET at import time (utils/email.ts transitively
// imports db/pool.ts -> config/env.ts), so these must exist for ANY test file
// that imports utils/email.ts to load at all, even though the functions under
// test here are pure and never actually open a DB connection (pg's Pool is
// lazy — constructing it doesn't connect). Do not point DATABASE_URL at a real
// database from tests.
export default defineConfig({
  test: {
    environment: 'node',
    env: {
      DATABASE_URL: 'postgres://test:test@localhost:5432/macrocore_test_unused',
      JWT_SECRET: 'test-only-jwt-secret-not-real',
      NODE_ENV: 'test',
    },
  },
});
