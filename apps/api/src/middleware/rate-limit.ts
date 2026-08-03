/**
 * Rate limiting for public (pre-tenant) endpoints — S8-06.
 *
 * The QR order endpoints are the app's first *unauthenticated writes*, so they
 * need a blunt per-IP throttle to slow token-guessing and ghost-order spam. This
 * is a small factory over `express-rate-limit` with sensible public-endpoint
 * defaults; other pre-tenant routes (`/pin` login, future `/online` ordering)
 * should adopt the same limiter — see the note in `app.ts`.
 *
 * Per-IP is a coarse control, not the security boundary: the real guarantee is
 * that a QR write derives tenant/outlet/table only from the resolved token
 * (see `qr-order.service.ts`). The limiter just bounds abuse volume.
 */

import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit'

export interface RateLimitOptions {
  /** Sliding window length in milliseconds. */
  windowMs?: number
  /** Max requests per IP per window. */
  max?: number
  /** Machine-readable code returned in the 429 body. */
  code?: string
}

/**
 * Builds a configured limiter. Defaults suit a public read endpoint; pass a
 * tighter `max` for write endpoints (order placement).
 */
export function createRateLimit(options: RateLimitOptions = {}): RateLimitRequestHandler {
  const { windowMs = 60_000, max = 60, code = 'RATE_LIMITED' } = options
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code, message: 'Too many requests; please slow down.' } },
  })
}
