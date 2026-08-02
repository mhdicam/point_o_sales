/**
 * PurchaseOrder routes — S6-06/07/08, design §4.5 (standard #5).
 *
 * Thin HTTP layer over `PurchaseOrderService`. Gated on BOTH the `purchasing`
 * feature (requireFeature — a service-only outlet leaves it off) and a purchase
 * permission (requirePermission — the security boundary, standard #5): reads +
 * draft mutations (create/updateDraft/submit) need `purchase.create`; approve and
 * cancel need `purchase.approve`; goods receipt needs `purchase.receive` (it moves
 * stock). Line quantities cross the wire as scaled integers and unit costs as
 * minor units via `zod-bigint`; the service owns the money math, the state-machine
 * guards, the APPROVED snapshot, and the receipt → StockMovement seam.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { PurchaseOrderService } from '../services/purchase-order.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { createFeatureMiddleware } from '../middleware/feature.middleware.js'
import { badRequest } from '../http-error.js'
import { positiveScaled, minorUnits } from '../zod-bigint.js'

const poIdSchema = z.string().uuid()

const lineSchema = z.object({
  variantId: z.string().uuid(),
  qtyOrderedScaled: positiveScaled,
  unitCost: minorUnits.optional(),
  sortOrder: z.number().int().min(0).optional(),
})

const createSchema = z.object({
  outletId: z.string().uuid(),
  supplierId: z.string().uuid(),
  expectedDate: z.coerce.date().optional().nullable(),
  taxRateBp: z.number().int().min(0).max(100_000).optional(),
  notes: z.string().max(2000).optional().nullable(),
  items: z.array(lineSchema).min(1),
})

const updateDraftSchema = z.object({
  expectedDate: z.coerce.date().optional().nullable(),
  taxRateBp: z.number().int().min(0).max(100_000).optional(),
  notes: z.string().max(2000).optional().nullable(),
  items: z.array(lineSchema).min(1).optional(),
})

const cancelSchema = z.object({
  reason: z.string().min(1).max(500),
})

const receiveSchema = z.object({
  lines: z
    .array(
      z.object({
        poItemId: z.string().uuid(),
        qtyScaled: positiveScaled,
      })
    )
    .min(1),
})

function parsePoId(raw: unknown): string {
  const parsed = poIdSchema.safeParse(raw)
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'Purchase order id must be a uuid')
  return parsed.data
}

/** Maps a validated line to the service input, dropping absent optionals. */
function toLineInput(line: z.infer<typeof lineSchema>) {
  return {
    variantId: line.variantId,
    qtyOrderedScaled: line.qtyOrderedScaled,
    ...(line.unitCost !== undefined ? { unitCost: line.unitCost } : {}),
    ...(line.sortOrder !== undefined ? { sortOrder: line.sortOrder } : {}),
  }
}

export function createPurchaseOrderRouter(db: BrewsyncClient): Router {
  const router = Router()
  const service = new PurchaseOrderService(db)
  const requirePermission = createPermissionMiddleware(db)
  const requireFeature = createFeatureMiddleware(db)

  // The purchasing feature gates the whole router (standard #5, FE mirror is UX only).
  router.use(requireFeature('purchasing'))

  // ---- Reads ----

  router.get('/', requirePermission(PERMISSIONS.PURCHASE_CREATE), async (req, res, next) => {
    try {
      const status = req.query['status']
      const orders = await service.list({
        ...(typeof req.query['outletId'] === 'string' ? { outletId: req.query['outletId'] } : {}),
        ...(typeof req.query['supplierId'] === 'string'
          ? { supplierId: req.query['supplierId'] }
          : {}),
        ...(typeof status === 'string' ? { status: status as never } : {}),
      })
      res.json({ purchaseOrders: orders })
    } catch (error) {
      next(error)
    }
  })

  router.get('/:id', requirePermission(PERMISSIONS.PURCHASE_CREATE), async (req, res, next) => {
    try {
      const po = await service.getById(parsePoId(req.params['id']))
      res.json({ purchaseOrder: po })
    } catch (error) {
      next(error)
    }
  })

  // ---- Draft lifecycle (create / update / submit) ----

  router.post('/', requirePermission(PERMISSIONS.PURCHASE_CREATE), async (req, res, next) => {
    try {
      const parsed = createSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid purchase order', parsed.error.issues)
      }
      const po = await service.create({
        outletId: parsed.data.outletId,
        supplierId: parsed.data.supplierId,
        ...(parsed.data.expectedDate !== undefined ? { expectedDate: parsed.data.expectedDate } : {}),
        ...(parsed.data.taxRateBp !== undefined ? { taxRateBp: parsed.data.taxRateBp } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        items: parsed.data.items.map(toLineInput),
      })
      res.status(201).json({ purchaseOrder: po })
    } catch (error) {
      next(error)
    }
  })

  router.put('/:id', requirePermission(PERMISSIONS.PURCHASE_CREATE), async (req, res, next) => {
    try {
      const parsed = updateDraftSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid purchase order', parsed.error.issues)
      }
      const po = await service.updateDraft(parsePoId(req.params['id']), {
        ...(parsed.data.expectedDate !== undefined ? { expectedDate: parsed.data.expectedDate } : {}),
        ...(parsed.data.taxRateBp !== undefined ? { taxRateBp: parsed.data.taxRateBp } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        ...(parsed.data.items !== undefined ? { items: parsed.data.items.map(toLineInput) } : {}),
      })
      res.json({ purchaseOrder: po })
    } catch (error) {
      next(error)
    }
  })

  router.post('/:id/submit', requirePermission(PERMISSIONS.PURCHASE_CREATE), async (req, res, next) => {
    try {
      const po = await service.submit(parsePoId(req.params['id']))
      res.json({ purchaseOrder: po })
    } catch (error) {
      next(error)
    }
  })

  // ---- Approval + cancellation (higher-privilege) ----

  router.post('/:id/approve', requirePermission(PERMISSIONS.PURCHASE_APPROVE), async (req, res, next) => {
    try {
      const po = await service.approve(parsePoId(req.params['id']))
      res.json({ purchaseOrder: po })
    } catch (error) {
      next(error)
    }
  })

  router.post('/:id/cancel', requirePermission(PERMISSIONS.PURCHASE_APPROVE), async (req, res, next) => {
    try {
      const parsed = cancelSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'A cancellation reason is required', parsed.error.issues)
      }
      const po = await service.cancel(parsePoId(req.params['id']), parsed.data.reason)
      res.json({ purchaseOrder: po })
    } catch (error) {
      next(error)
    }
  })

  // ---- Goods receipt (S6-07/08) — moves stock, so its own permission. ----

  router.post('/:id/receive', requirePermission(PERMISSIONS.PURCHASE_RECEIVE), async (req, res, next) => {
    try {
      const parsed = receiveSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid goods receipt', parsed.error.issues)
      }
      const po = await service.receive(parsePoId(req.params['id']), {
        lines: parsed.data.lines.map((l) => ({ poItemId: l.poItemId, qtyScaled: l.qtyScaled })),
      })
      res.json({ purchaseOrder: po })
    } catch (error) {
      next(error)
    }
  })

  return router
}
