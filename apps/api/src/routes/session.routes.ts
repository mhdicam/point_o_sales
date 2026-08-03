/**
 * Session scope routes — S2-09.
 *
 * GET  /session/memberships — tenants (and their outlets) this login can act in.
 * POST /session/select      — pick one, and get a token scoped to it.
 *
 * These sit *after* the tenant middleware — a valid access token is required —
 * but deliberately *not* behind `requireTenant`. A session that has just logged
 * in with email/password holds no tenant yet, and this is the route that gives
 * it one; gating it on having a tenant would make the scope unreachable.
 *
 * That is also why this cannot live in createMeRouter, whose `router.use(
 * requireTenant)` closes every route inside it.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { getTenantContext } from '@brewsync/db'
import type { Config } from '../config.js'
import { SessionService } from '../services/session.service.js'
import { TokenService } from '../services/token.service.js'
import { unauthorized } from '../http-error.js'
import type { SystemClient } from '../system-client.js'

const selectSchema = z.object({
  tenantId: z.string().uuid(),
  /** Optional: a tenant-wide session (an owner in the admin UI) has no outlet. */
  outletId: z.string().uuid().optional(),
})

export function createSessionRouter(db: BrewsyncClient, config: Config, system: SystemClient): Router {
  const router = Router()
  const sessionService = new SessionService(db, system)
  const tokenService = new TokenService(config, db)

  /**
   * The subject of the verified token. Not read from the body on purpose: the
   * body says which tenant is wanted, the token says who is asking.
   */
  const subjectOf = (): string => {
    const context = getTenantContext()
    if (!context?.userId) throw unauthorized('Token carries no subject')
    return context.userId
  }

  router.get('/memberships', async (_req, res, next) => {
    try {
      const memberships = await sessionService.listMemberships(subjectOf())
      res.json({ memberships })
    } catch (error) {
      next(error)
    }
  })

  router.post('/select', async (req, res, next) => {
    try {
      const userId = subjectOf()
      const { tenantId, outletId } = selectSchema.parse(req.body)

      const scope = await sessionService.selectScope(userId, tenantId, outletId)

      // A new pair rather than a patched access token: the refresh token has to
      // record the new scope too, or the next rotation would hand back a token
      // scoped to whatever was selected before.
      const tokens = await tokenService.issue({
        sub: userId,
        tenantId: scope.tenantId,
        outletId: scope.outletId,
      })

      res.json({ scope, ...tokens })
    } catch (error) {
      next(error)
    }
  })

  return router
}
