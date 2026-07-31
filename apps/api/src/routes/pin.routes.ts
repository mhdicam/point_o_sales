/**
 * PIN login route — S2-06.
 *
 * POST /pin/login — authenticate a cashier on a provisioned POS device.
 *
 * This route sits *before* the tenant middleware, because a device at the login
 * screen holds no access token yet. It therefore binds the tenant context itself
 * from the `tenantId` + `outletId` the device sends.
 *
 * A client-supplied tenantId is not an escalation hole: it is a *selector*, not
 * a credential, in exactly the same way an email is on a password login. The
 * membership lookup runs scoped to that tenant, so presenting tenant B's id with
 * tenant A's employee code and PIN matches nothing and fails. What authenticates
 * is the PIN, and a PIN is only ever valid inside the tenant that issued it.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { runWithTenantContext } from '@brewsync/db'
import type { Config } from '../config.js'
import { PinService } from '../services/pin.service.js'
import { TokenService } from '../services/token.service.js'

const pinLoginSchema = z.object({
  /** Provisioned onto the device, not chosen by the cashier. */
  tenantId: z.string().uuid(),
  outletId: z.string().uuid(),
  employeeCode: z.string().min(1),
  pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits'),
})

export function createPinRouter(db: BrewsyncClient, config: Config): Router {
  const router = Router()
  const pinService = new PinService(db)
  const tokenService = new TokenService(config, db)

  router.post('/login', async (req, res, next) => {
    try {
      const { tenantId, outletId, employeeCode, pin } = pinLoginSchema.parse(req.body)

      // Bind the context before touching the database so the membership lookup
      // is scoped by the extension and backed by RLS.
      const result = await runWithTenantContext({ tenantId, outletId }, () =>
        pinService.login({ employeeCode, pin, outletId })
      )

      // The access token carries the context the device will operate in, so
      // every subsequent request is scoped from the token rather than the body.
      const tokens = await tokenService.issue({
        sub: result.user.id,
        tenantId,
        outletId,
      })

      res.json({ user: result.user, membershipId: result.membershipId, ...tokens })
    } catch (error) {
      next(error)
    }
  })

  return router
}
