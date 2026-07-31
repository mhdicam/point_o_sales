/**
 * Permission middleware — S2-04.
 *
 * Guard endpoints with `requirePermission('order.void')`. Returns 403 when the
 * user lacks the permission at the outlet in context.
 *
 * Standard #5: feature toggles and permissions are guarded on **both** sides.
 * Frontend (usePermission) is UX only; backend is the security boundary.
 * FE-only guarding is a bug.
 */

import type { Request, Response, NextFunction } from 'express'
import { getTenantContext } from '@brewsync/db'
import type { PermissionKey } from '@brewsync/shared'
import { forbidden } from '../http-error.js'
import { PermissionService } from '../services/permission.service.js'
import type { BrewsyncClient } from '@brewsync/db'

export function createPermissionMiddleware(db: BrewsyncClient) {
  const permissionService = new PermissionService(db)

  return function requirePermission(...required: PermissionKey[]) {
    return async (_req: Request, _res: Response, next: NextFunction) => {
      const context = getTenantContext()

      if (!context?.userId) {
        return next(forbidden('NO_USER', 'User context required'))
      }

      if (!context.tenantId) {
        return next(forbidden('NO_TENANT', 'Tenant context required'))
      }

      const effective = await permissionService.getEffectivePermissions(
        context.userId,
        context.outletId
      )

      const missing = required.filter((p) => !effective.has(p))

      if (missing.length > 0) {
        return next(
          forbidden('INSUFFICIENT_PERMISSIONS', 'Missing required permissions', {
            required,
            missing,
          })
        )
      }

      next()
    }
  }
}
