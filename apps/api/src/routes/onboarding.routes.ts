/**
 * Onboarding routes — S2-08 tenant provisioning.
 *
 * This endpoint sits BEFORE the tenant middleware: the tenant being created does
 * not exist yet. Authorization is via an optional platform token; when unset, the
 * endpoint is not mounted and tenant creation becomes an out-of-band operation.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import type { Config } from '../config.js'
import { OnboardingService } from '../services/onboarding.service.js'
import { unauthorized, badRequest } from '../http-error.js'
import { BUSINESS_PRESETS, FEATURE_KEYS } from '@brewsync/shared'

const onboardTenantSchema = z.object({
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, numbers, and hyphens only'),
  name: z.string().min(1).max(200),
  preset: z.enum(BUSINESS_PRESETS),
  timezone: z.string().optional(),
  currency: z.string().length(3).optional(),
  outlet: z.object({
    code: z.string().min(1).max(20),
    name: z.string().min(1).max(200),
  }),
  owner: z.object({
    email: z.string().email(),
    fullName: z.string().min(1).max(200),
  }),
  // Validate against the real feature key catalog rather than accepting
  // arbitrary strings. Unknown keys are rejected at the boundary.
  featureOverrides: z
    .record(z.enum(FEATURE_KEYS), z.boolean())
    .optional(),
})

/**
 * Platform token guard. A missing or wrong token is 401. When the token is not
 * configured at all, the route is unmounted so this guard never runs.
 */
function requirePlatformToken(platformToken: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.headers.authorization
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null

    if (bearer !== platformToken) {
      throw unauthorized('Invalid or missing platform token')
    }

    next()
  }
}

export function createOnboardingRouter(db: BrewsyncClient, config: Config): Router | null {
  // When PLATFORM_API_TOKEN is unset, return null — app.ts will not mount the
  // route, and tenant provisioning becomes an out-of-band operation (manual SQL
  // or a dedicated admin tool).
  if (!config.PLATFORM_API_TOKEN) {
    return null
  }

  const router = Router()
  const onboardingService = new OnboardingService(db)

  router.post('/tenants', requirePlatformToken(config.PLATFORM_API_TOKEN), async (req, res, next) => {
    try {
      const parsed = onboardTenantSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid onboarding data', parsed.error.issues)
      }

      const result = await onboardingService.onboard(parsed.data)
      res.status(201).json(result)
    } catch (error) {
      next(error)
    }
  })

  return router
}
