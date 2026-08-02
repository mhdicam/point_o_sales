/**
 * Order routes — S4, design §6/§7.
 *
 * Thin HTTP layer over `OrderService`. Every endpoint is permission-guarded
 * (standard #5 — the backend is the security boundary) and Zod-validated. Money
 * crosses the wire as decimal strings via `minorUnits`/`signedMinorUnits`
 * (standard #2); the global `json replacer` serializes BigInt back out the same
 * way. The service owns the state machine and pipeline — this file only shapes
 * requests and forwards errors to the shared handler (which already maps the
 * service's HttpError 409 for illegal transitions and the OPEN-only guard).
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { OrderService } from '../services/order.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { createFeatureMiddleware } from '../middleware/feature.middleware.js'
import { badRequest } from '../http-error.js'
import { minorUnits } from '../zod-bigint.js'

const uuidSchema = z.string().uuid()

const orderItemSchema = z.object({
  variantId: z.string().uuid(),
  qty: z.number().int().min(1),
  modifierIds: z.array(z.string().uuid()).optional(),
})

const createOrderSchema = z.object({
  outletId: z.string().uuid(),
  channel: z.enum(['STAFF', 'QR_TABLE', 'ONLINE']).optional(),
  salesMethod: z.string().min(1).max(100).optional().nullable(),
  items: z.array(orderItemSchema).optional(),
})

const addItemSchema = orderItemSchema

const changeQtySchema = z.object({
  qty: z.number().int().min(1),
})

/** A discount is exactly one of a percent (basis points) or a fixed amount. */
const discountSchema = z
  .object({
    label: z.string().min(1).max(200),
    rateBp: z.number().int().min(0).max(100000).optional(),
    amountMinor: minorUnits.optional(),
  })
  .refine((d) => (d.rateBp !== undefined) !== (d.amountMinor !== undefined), {
    message: 'A discount must set exactly one of rateBp or amountMinor.',
  })

const gratuitySchema = z.object({
  gratuityMinor: minorUnits,
})

/** Floor operations (§5.4) — transfer a table, merge two orders, move items. */
const transferSchema = z.object({
  targetTableId: z.string().uuid(),
})

const mergeSchema = z.object({
  absorbedOrderId: z.string().uuid(),
})

const moveItemsSchema = z.object({
  toOrderId: z.string().uuid(),
  orderItemIds: z.array(z.string().uuid()).min(1),
})

const statusSchema = z.enum(['OPEN', 'SENT', 'SERVED', 'BILLED', 'PAID', 'CLOSED', 'VOID'])

function parseId(raw: unknown, what: string): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', `${what} must be a uuid`)
  }
  return parsed.data
}

export function createOrderRouter(db: BrewsyncClient): Router {
  const router = Router()
  const orders = new OrderService(db)
  const requirePermission = createPermissionMiddleware(db)
  const requireFeature = createFeatureMiddleware(db)

  // ---- Reads ----

  router.get('/', requirePermission(PERMISSIONS.ORDER_CREATE), async (req, res, next) => {
    try {
      const outletId = req.query['outletId']
      const status = req.query['status']
      const parsedStatus = typeof status === 'string' ? statusSchema.safeParse(status) : null
      const list = await orders.list({
        ...(typeof outletId === 'string' && uuidSchema.safeParse(outletId).success
          ? { outletId }
          : {}),
        ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
      })
      res.json({ orders: list })
    } catch (error) {
      next(error)
    }
  })

  router.get('/:id', requirePermission(PERMISSIONS.ORDER_CREATE), async (req, res, next) => {
    try {
      const order = await orders.getById(parseId(req.params['id'], 'Order id'))
      res.json({ order })
    } catch (error) {
      next(error)
    }
  })

  // ---- Lifecycle ----

  router.post('/', requirePermission(PERMISSIONS.ORDER_CREATE), async (req, res, next) => {
    try {
      const parsed = createOrderSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid order data', parsed.error.issues)
      }
      const order = await orders.create(parsed.data)
      res.status(201).json({ order })
    } catch (error) {
      next(error)
    }
  })

  router.post('/:id/items', requirePermission(PERMISSIONS.ORDER_EDIT), async (req, res, next) => {
    try {
      const parsed = addItemSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid order item', parsed.error.issues)
      }
      const order = await orders.addItem(parseId(req.params['id'], 'Order id'), parsed.data)
      res.status(201).json({ order })
    } catch (error) {
      next(error)
    }
  })

  router.put(
    '/:id/items/:itemId',
    requirePermission(PERMISSIONS.ORDER_EDIT),
    async (req, res, next) => {
      try {
        const parsed = changeQtySchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid quantity', parsed.error.issues)
        }
        const order = await orders.changeItemQty(
          parseId(req.params['id'], 'Order id'),
          parseId(req.params['itemId'], 'Order item id'),
          parsed.data.qty
        )
        res.json({ order })
      } catch (error) {
        next(error)
      }
    }
  )

  router.delete(
    '/:id/items/:itemId',
    requirePermission(PERMISSIONS.ORDER_EDIT),
    async (req, res, next) => {
      try {
        const order = await orders.removeItem(
          parseId(req.params['id'], 'Order id'),
          parseId(req.params['itemId'], 'Order item id')
        )
        res.json({ order })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post('/:id/send', requirePermission(PERMISSIONS.ORDER_SEND), async (req, res, next) => {
    try {
      const order = await orders.send(parseId(req.params['id'], 'Order id'))
      res.json({ order })
    } catch (error) {
      next(error)
    }
  })

  router.post('/:id/serve', requirePermission(PERMISSIONS.ORDER_SEND), async (req, res, next) => {
    try {
      const order = await orders.markServed(parseId(req.params['id'], 'Order id'))
      res.json({ order })
    } catch (error) {
      next(error)
    }
  })

  router.post('/:id/bill', requirePermission(PERMISSIONS.ORDER_SEND), async (req, res, next) => {
    try {
      const order = await orders.bill(parseId(req.params['id'], 'Order id'))
      res.json({ order })
    } catch (error) {
      next(error)
    }
  })

  // ---- Discounts & gratuity ----

  router.post(
    '/:id/items/:itemId/discount',
    requirePermission(PERMISSIONS.DISCOUNT_APPLY),
    async (req, res, next) => {
      try {
        const parsed = discountSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid discount', parsed.error.issues)
        }
        const order = await orders.applyItemDiscount(
          parseId(req.params['id'], 'Order id'),
          parseId(req.params['itemId'], 'Order item id'),
          parsed.data
        )
        res.json({ order })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/:id/discount',
    requirePermission(PERMISSIONS.DISCOUNT_APPLY),
    async (req, res, next) => {
      try {
        const parsed = discountSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid discount', parsed.error.issues)
        }
        const order = await orders.applyOrderDiscount(
          parseId(req.params['id'], 'Order id'),
          parsed.data
        )
        res.json({ order })
      } catch (error) {
        next(error)
      }
    }
  )

  router.put(
    '/:id/gratuity',
    requirePermission(PERMISSIONS.DISCOUNT_APPLY),
    async (req, res, next) => {
      try {
        const parsed = gratuitySchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid gratuity', parsed.error.issues)
        }
        const order = await orders.setGratuity(
          parseId(req.params['id'], 'Order id'),
          parsed.data.gratuityMinor
        )
        res.json({ order })
      } catch (error) {
        next(error)
      }
    }
  )

  // ---- Voids ----

  router.post('/:id/void', requirePermission(PERMISSIONS.ORDER_VOID), async (req, res, next) => {
    try {
      const order = await orders.void(parseId(req.params['id'], 'Order id'))
      res.json({ order })
    } catch (error) {
      next(error)
    }
  })

  router.post(
    '/:id/items/:itemId/void',
    requirePermission(PERMISSIONS.ORDER_ITEM_VOID),
    async (req, res, next) => {
      try {
        const order = await orders.voidItem(
          parseId(req.params['id'], 'Order id'),
          parseId(req.params['itemId'], 'Order item id')
        )
        res.json({ order })
      } catch (error) {
        next(error)
      }
    }
  )

  // ---- Floor operations (§5.4) — gated by the `tables` feature ----

  router.post(
    '/:id/transfer',
    requireFeature('tables'),
    requirePermission(PERMISSIONS.ORDER_TRANSFER),
    async (req, res, next) => {
      try {
        const parsed = transferSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid transfer', parsed.error.issues)
        }
        const order = await orders.transfer(
          parseId(req.params['id'], 'Order id'),
          parsed.data.targetTableId
        )
        res.json({ order })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/:id/merge',
    requireFeature('tables'),
    requirePermission(PERMISSIONS.ORDER_TRANSFER),
    async (req, res, next) => {
      try {
        const parsed = mergeSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid merge', parsed.error.issues)
        }
        const result = await orders.merge(
          parseId(req.params['id'], 'Order id'),
          parsed.data.absorbedOrderId
        )
        res.json(result)
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/:id/move-items',
    requireFeature('tables'),
    requirePermission(PERMISSIONS.ORDER_TRANSFER),
    async (req, res, next) => {
      try {
        const parsed = moveItemsSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid move', parsed.error.issues)
        }
        const result = await orders.moveItems(
          parseId(req.params['id'], 'Order id'),
          parsed.data.toOrderId,
          parsed.data.orderItemIds
        )
        res.json(result)
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
