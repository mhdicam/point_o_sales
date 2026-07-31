/**
 * Example guarded routes — demonstrates S2-04/S2-07 middleware.
 *
 * Real feature routes arrive in S3+. This exists so the S2 acceptance criterion
 * ("endpoint sensitif nolak user tanpa permission") has something to test
 * against, and so the wiring order for the two guards is written down once.
 */

import { Router } from 'express'
import type { BrewsyncClient } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { createFeatureMiddleware } from '../middleware/feature.middleware.js'

export function createExampleRouter(db: BrewsyncClient): Router {
  const router = Router()
  const requirePermission = createPermissionMiddleware(db)
  const requireFeature = createFeatureMiddleware(db)

  // S2-04 — permission guard. A user without product.view gets 403.
  router.get('/products', requirePermission(PERMISSIONS.PRODUCT_VIEW), (_req, res) => {
    res.json({ message: 'guarded by product.view' })
  })

  // S2-07 — feature guard. An outlet with `barcode` off gets 403.
  router.get('/scan', requireFeature('barcode'), (_req, res) => {
    res.json({ message: 'guarded by the barcode toggle' })
  })

  // Both guards. Feature first: "this outlet does not do KDS at all" is a
  // clearer answer than "you may not create KDS orders", and it avoids a
  // permission lookup for a capability the tenant has not bought.
  router.post(
    '/kds-orders',
    requireFeature('kds'),
    requirePermission(PERMISSIONS.ORDER_CREATE),
    (_req, res) => {
      res.json({ message: 'guarded by kds + order.create' })
    }
  )

  return router
}
