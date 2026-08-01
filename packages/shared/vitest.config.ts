import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Pinned so an ambient NODE_ENV from the shell cannot leak in — see the note
    // in apps/api/vitest.config.ts.
    env: { NODE_ENV: 'test' },
  },
})
