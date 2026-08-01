import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // Pinned, not left to vitest's default. The integration tests load the root
    // `.env` for DB URLs, and that file carries NODE_ENV=development; dotenv
    // won't overwrite an already-set var, so an ambient NODE_ENV from the shell
    // survives into the run. That flips config.isTest false, and the logger then
    // builds a pino-pretty transport whose worker cannot resolve under vitest.
    env: { NODE_ENV: 'test' },
    // Integration tests hit Postgres and argon2-hash PINs; the default 5s is
    // tight for the first run when the pool is cold.
    testTimeout: 30000,
    // Tests share one database, and several assert on per-membership lockout
    // counters. Running files in parallel would let one test's failed-attempt
    // writes race another's.
    fileParallelism: false,
  },
})
