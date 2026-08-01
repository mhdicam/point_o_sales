/**
 * /me routes — S2-03/S2-05/S2-07.
 *
 * GET /me/permissions — effective permissions for the session user.
 * GET /me/features    — feature toggles for the session's tenant.
 *
 * The FE usePermission and useFeature hooks consume these to decide what UI to
 * show. Neither substitutes for BE guards: standard #5 says FE is UX only, BE
 * is the security boundary.
 */

import { Router } from 'express'
import type { BrewsyncClient } from '@brewsync/db'
import { getTenantContext } from '@brewsync/db'
import { PermissionService } from '../services/permission.service.js'
import { FeatureService } from '../services/feature.service.js'
import { requireTenant } from '../middleware/tenant.middleware.js'
import { unauthorized } from '../http-error.js'

export function createMeRouter(db: BrewsyncClient): Router {
  const router = Router()
  const permissionService = new PermissionService(db)
  const featureService = new FeatureService(db)

  // Effective permissions and feature toggles both depend on tenant context.
  router.use(requireTenant)

  router.get('/permissions', async (_req, res, next) => {
    try {
      const context = getTenantContext()

      // requireTenant guarantees tenantId, but userId comes from the token's
      // `sub` claim — treat its absence as an unusable session rather than
      // asserting it away.
      if (!context?.userId) {
        throw unauthorized('Token carries no subject')
      }

      const permissions = await permissionService.getEffectivePermissions(
        context.userId,
        context.outletId
      )

      res.json({ permissions: Array.from(permissions) })
    } catch (error) {
      next(error)
    }
  })

  router.get('/features', async (_req, res, next) => {
    try {
      const features = await featureService.getFeatures()

      // No BusinessProfile means onboarding never finished for this tenant.
      // Reported as an empty toggle set rather than 404: the session is valid,
      // there is simply nothing enabled, and the FE hook wants a shape it can
      // read either way.
      res.json({ features: features ?? {} })
    } catch (error) {
      next(error)
    }
  })

  return router
}
