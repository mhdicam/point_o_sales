/**
 * /me routes — S2-03/S2-05.
 *
 * GET /me/permissions — effective permissions for the session user.
 *
 * The FE usePermission hook consumes this to decide what UI to show. It does
 * not substitute for BE guards: standard #5 says FE is UX only, BE is the
 * security boundary.
 */

import { Router } from 'express'
import type { BrewsyncClient } from '@brewsync/db'
import { getTenantContext } from '@brewsync/db'
import { PermissionService } from '../services/permission.service.js'
import { requireTenant } from '../middleware/tenant.middleware.js'
import { unauthorized } from '../http-error.js'

export function createMeRouter(db: BrewsyncClient): Router {
  const router = Router()
  const permissionService = new PermissionService(db)

  // Effective permissions depend on tenant context, so require it first.
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

  return router
}
