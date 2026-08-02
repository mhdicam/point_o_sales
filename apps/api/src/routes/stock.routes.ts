/**
 * Stock routes — S6-01, design §4 (standard #5).
 *
 * Thin HTTP layer over `StockService`. Reads are gated on `inventory.view`;
 * the stock-take / waste adjustment is gated on `inventory.adjust` — the backend
 * is the security boundary (standard #5). Quantities cross the wire as scaled
 * integers (the variant's stock unit × UNIT_FACTOR_SCALE) via the `zod-bigint`
 * helpers; the service converts to base units and owns the ledger + the
 * `StockAdjusted` emit. This file only shapes requests and forwards errors.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { StockService } from '../services/stock.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { badRequest } from '../http-error.js'
import { signedMinorUnits } from '../zod-bigint.js'

const uuidSchema = z.string().uuid()

const adjustSchema = z.object({
  outletId: z.string().uuid(),
  variantId: z.string().uuid(),
  /** Signed quantity in the variant's stock unit, scaled by UNIT_FACTOR_SCALE. */
  qtyScaled: signedMinorUnits,
  type: z.enum(['ADJUSTMENT', 'WASTE', 'TRANSFER', 'PRODUCTION']),
  /** Optional cost per one base unit, minor units — a pure count omits it. */
  costPerUnit: signedMinorUnits.optional(),
  reason: z.string().min(1).max(500).optional(),
})

function requireUuidQuery(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || !uuidSchema.safeParse(raw).success) {
    throw badRequest('VALIDATION_ERROR', `${what} query param must be a uuid`)
  }
  return raw
}

export function createStockRouter(db: BrewsyncClient): Router {
  const router = Router()
  const stock = new StockService(db)
  const requirePermission = createPermissionMiddleware(db)

  // ---- On-hand + valuation for one variant at one outlet (§4.3) ----

  router.get('/on-hand', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (req, res, next) => {
    try {
      const outletId = requireUuidQuery(req.query['outletId'], 'outletId')
      const variantId = requireUuidQuery(req.query['variantId'], 'variantId')
      const onHand = await stock.onHand(outletId, variantId)
      res.json({ onHand })
    } catch (error) {
      next(error)
    }
  })

  // ---- Outlet-wide inventory valuation summary (§4.3) ----

  router.get('/valuation', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (req, res, next) => {
    try {
      const outletId = requireUuidQuery(req.query['outletId'], 'outletId')
      const valuation = await stock.outletValuation(outletId)
      res.json({ valuation })
    } catch (error) {
      next(error)
    }
  })

  // ---- The inventory-card ledger for a variant (audit view) ----

  router.get('/history', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (req, res, next) => {
    try {
      const outletId = requireUuidQuery(req.query['outletId'], 'outletId')
      const variantId = requireUuidQuery(req.query['variantId'], 'variantId')
      const limitRaw = req.query['limit']
      const limit = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : undefined
      const movements = await stock.history(
        outletId,
        variantId,
        Number.isFinite(limit) ? (limit as number) : undefined
      )
      res.json({ movements })
    } catch (error) {
      next(error)
    }
  })

  // ---- Stock take / waste / manual correction (§4.1) ----

  router.post('/adjust', requirePermission(PERMISSIONS.INVENTORY_ADJUST), async (req, res, next) => {
    try {
      const parsed = adjustSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid stock adjustment', parsed.error.issues)
      }
      const onHand = await stock.adjust({
        outletId: parsed.data.outletId,
        variantId: parsed.data.variantId,
        qtyScaled: parsed.data.qtyScaled,
        type: parsed.data.type,
        ...(parsed.data.costPerUnit !== undefined ? { costPerUnit: parsed.data.costPerUnit } : {}),
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
      })
      res.status(201).json({ onHand })
    } catch (error) {
      next(error)
    }
  })

  return router
}
