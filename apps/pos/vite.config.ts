/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The POS app talks to the Express API. In dev, requests to /api are proxied so
// the browser stays same-origin (no CORS preflight); in prod, VITE_API_URL is
// baked in and the api-client reads it. Default target matches apps/api PORT.
const API_TARGET = process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
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
