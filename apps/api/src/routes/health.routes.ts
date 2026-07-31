/**
 * S0-07 — /health endpoint.
 *
 * Returns 200 when the service is up and the database is reachable. Kubernetes
 * liveness/readiness probes hit this.
 */

import { Router } from 'express'
import type { BrewsyncClient } from '@brewsync/db'

export function createHealthRouter(db: BrewsyncClient): Router {
  const router = Router()

  router.get('/health', async (_req, res, next) => {
    try {
      await db.$queryRaw`SELECT 1`
      res.json({ status: 'healthy', timestamp: new Date().toISOString() })
    } catch (error) {
      next(error)
    }
  })

  return router
}
