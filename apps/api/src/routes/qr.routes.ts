/**
 * QR self-service order routes — S8-06, design §16.2.
 *
 * PUBLIC and unauthenticated: mounted BEFORE the tenant middleware (like
 * `/pin`), because a customer scanning a table QR holds no access token. Unlike
 * every other write in the app, there is no user and no client-supplied tenant —
 * the tenant/outlet/table are derived ENTIRELY from the `:token` path param via
 * `QrOrderService.resolveTable`, which is the whole security argument (§16.2).
 *
 * There is therefore no permission middleware here. The feature gate (`qrOrder`)
 * is enforced INSIDE the service, after the token resolves a tenant to check it
 * against — a `requireFeature` middleware would need a tenant context the public
 * request doesn't have yet. A basic per-IP rate limiter fronts both routes, with
 * a tighter cap on the order-placement write than the menu read.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { QrOrderService } from '../services/qr-order.service.js'
import { createRateLimit } from '../middleware/rate-limit.js'
import { badRequest, notFound } from '../http-error.js'
import type { SystemClient } from '../system-client.js'

const placeOrderSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        qty: z.number().int().min(1),
        modifierIds: z.array(z.string().uuid()).optional(),
      })
    )
    .min(1, 'An order needs at least one item.'),
})

/** Pull the `:token` path param as a plain string; a malformed one is opaque. */
function readToken(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') {
    throw notFound('QR_INVALID', 'This QR code is not valid.')
  }
  return raw
}

export function createQrRouter(db: BrewsyncClient, system: SystemClient): Router {
  const router = Router()
  const qr = new QrOrderService(db, system)

  // Public-endpoint throttles: a generous read cap, a tighter write cap.
  const readLimit = createRateLimit({ windowMs: 60_000, max: 60, code: 'QR_RATE_LIMITED' })
  const writeLimit = createRateLimit({ windowMs: 60_000, max: 10, code: 'QR_RATE_LIMITED' })

  // GET /qr/:token — resolve the table and return its dine-in menu.
  router.get('/qr/:token', readLimit, async (req, res, next) => {
    try {
      const resolved = await qr.resolveTable(readToken(req.params['token']))
      const menu = await qr.menu(resolved)
      res.json({
        table: { name: resolved.tableName },
        outlet: { id: resolved.outletId },
        ...menu,
      })
    } catch (error) {
      next(error)
    }
  })

  // POST /qr/:token/orders — place a QR_TABLE order on the resolved table.
  router.post('/qr/:token/orders', writeLimit, async (req, res, next) => {
    try {
      const parsed = placeOrderSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid order', parsed.error.issues)
      }
      const resolved = await qr.resolveTable(readToken(req.params['token']))
      const result = await qr.placeOrder(resolved, parsed.data.items)
      res.status(201).json(result)
    } catch (error) {
      next(error)
    }
  })

  return router
}
