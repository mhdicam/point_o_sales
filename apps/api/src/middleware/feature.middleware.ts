/**
 * Feature middleware — S2-07.
 *
 * Guard endpoints with `requireFeature('tables')`. Returns 403 when the tenant's
 * BusinessProfile has the toggle off.
 *
 * Standard #5: feature toggles and permissions are guarded on **both** sides.
 * Frontend (useFeature) is UX only; backend is the security boundary.
 */

import type { Request, Response, NextFunction } from 'express'
import { getTenantContext } from '@brewsync/db'
import type { FeatureKey } from '@brewsync/shared'
import { forbidden } from '../http-error.js'
import { FeatureService } from '../services/feature.service.js'
import type { BrewsyncClient } from '@brewsync/db'

export function createFeatureMiddleware(db: BrewsyncClient) {
  const featureService = new FeatureService(db)

  return function requireFeature(...required: FeatureKey[]) {
    return async (_req: Request, _res: Response, next: NextFunction) => {
      const context = getTenantContext()

      if (!context?.tenantId) {
        return next(forbidden('NO_TENANT', 'Tenant context required'))
      }

      const disabled = await featureService.getDisabled(required)

      if (disabled.length > 0) {
        return next(
          forbidden('FEATURE_DISABLED', 'Required features are not enabled', {
            required,
            disabled,
          })
        )
      }

      next()
    }
  }
}
