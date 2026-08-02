/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The customer-facing landing/ordering app talks to the same Express API as the
// POS. In dev, requests to /api are proxied so the browser stays same-origin (no
// CORS preflight); in prod, VITE_API_URL is baked in and the api-client reads it.
// A distinct dev port from the POS app (5173) so both can run at once.
const API_TARGET = process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/vitest.setup.ts'],
  },
})
