import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests hit Postgres and argon2-hash PINs; the default 5s is
    // tight for the first run when the pool is cold.
    testTimeout: 30000,
    // Tests share one database, and several assert on per-membership lockout
    // counters. Running files in parallel would let one test's failed-attempt
    // writes race another's.
    fileParallelism: false,
  },
})
