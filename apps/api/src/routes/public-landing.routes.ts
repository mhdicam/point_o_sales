/**
 * Public landing page routes — S9-03, design §17 / §17.1.
 *
 * PUBLIC and unauthenticated: mounted BEFORE the tenant middleware (like `/qr`
 * and `/pin`), because a customer opening a public catalog holds no access token.
 * The tenant/outlet are derived ENTIRELY from the `:slug` path param via
 * `PublicLandingService.resolveSlug` — never client input — which is the whole
 * security argument.
 *
 * There is therefore no permission middleware here. The feature gate
 * (`landingPage`) is enforced INSIDE the service, after the slug resolves a
 * tenant to check it against. A per-IP rate limiter fronts the route, as with the
 * QR endpoints; S9-04 adds the `POST /p/:slug/orders` write with a tighter cap.
 *
 * Note the route path is the literal `/p/:slug` (a single, non-tenant path
 * segment), distinct from the authenticated `/landing` CMS surface (S9-02).
 */

import { Router } from 'express'
import type { BrewsyncClient } from '@brewsync/db'
import { PublicLandingService } from '../services/public-landing.service.js'
import { createRateLimit } from '../middleware/rate-limit.js'
import { notFound } from '../http-error.js'

/** Pull the `:slug` path param as a plain string; a malformed one is opaque. */
function readSlug(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') {
    throw notFound('LANDING_INVALID', 'This page is not available.')
  }
  return raw
}

export function createPublicLandingRouter(db: BrewsyncClient): Router {
  const router = Router()
  const landing = new PublicLandingService(db)

  // Public-read throttle, same shape as the QR menu read.
  const readLimit = createRateLimit({ windowMs: 60_000, max: 60, code: 'LANDING_RATE_LIMITED' })

  // GET /p/:slug — resolve the published page and return it with live catalog data.
  router.get('/p/:slug', readLimit, async (req, res, next) => {
    try {
      const resolved = await landing.resolveSlug(readSlug(req.params['slug']))
      const page = await landing.buildPage(resolved)
      res.json(page)
    } catch (error) {
      next(error)
    }
  })

  return router
}
