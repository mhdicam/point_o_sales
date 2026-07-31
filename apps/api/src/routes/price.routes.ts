/**
 * Price routes — S3-05, design §3.3.
 *
 * Two shapes here: PriceList/PriceListItem administration (product.edit), and
 * the resolver read endpoint the POS grid calls (product.view).
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { PriceService } from '../services/price.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { PERMISSIONS } from '@brewsync/shared'
import { badRequest } from '../http-error.js'
import { minorUnits } from '../zod-bigint.js'

const createListSchema = z.object({
  name: z.string().min(1).max(100),
  outletId: z.string().uuid().optional().nullable(),
  salesMethod: z.string().min(1).max(50).optional().nullable(),
  priority: z.number().int().min(0).max(1000).optional(),
  validFrom: z.coerce.date().optional().nullable(),
  validTo: z.coerce.date().optional().nullable(),
})

const updateListSchema = createListSchema.partial().extend({
  isActive: z.boolean().optional(),
})

const setItemSchema = z.object({
  variantId: z.string().uuid(),
  price: minorUnits,
})

const setItemsSchema = z.object({
  items: z.array(setItemSchema).min(1).max(500),
})

/** Resolver query: which variants, in which context. */
const resolveSchema = z.object({
  variantIds: z.array(z.string().uuid()).min(1).max(500),
  outletId: z.string().uuid().optional().nullable(),
  salesMethod: z.string().min(1).max(50).optional().nullable(),
  at: z.coerce.date().optional(),
})

const uuidSchema = z.string().uuid()

function parseUuid(raw: unknown, label: string): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', `${label} must be a uuid`)
  }
  return parsed.data
}

export function createPriceRouter(db: BrewsyncClient): Router {
  const router = Router()
  const priceService = new PriceService(db)
  const requirePermission = createPermissionMiddleware(db)

  // ---- Resolver ----

  // POST rather than GET: a cashier grid resolves hundreds of variant ids at
  // once, which does not fit a query string.
  router.post('/resolve', requirePermission(PERMISSIONS.PRODUCT_VIEW), async (req, res, next) => {
    try {
      const parsed = resolveSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid resolve request', parsed.error.issues)
      }

      const resolved = await priceService.resolveMany(parsed.data.variantIds, {
        outletId: parsed.data.outletId ?? null,
        salesMethod: parsed.data.salesMethod ?? null,
        ...(parsed.data.at && { at: parsed.data.at }),
      })

      res.json({ prices: Array.from(resolved.values()) })
    } catch (error) {
      next(error)
    }
  })

  // ---- Price lists ----

  router.get('/lists', requirePermission(PERMISSIONS.PRODUCT_VIEW), async (req, res, next) => {
    try {
      const outletId = req.query['outletId']
      const lists = await priceService.listLists({
        ...(typeof outletId === 'string' && uuidSchema.safeParse(outletId).success
          ? { outletId }
          : {}),
        includeInactive: req.query['includeInactive'] === 'true',
      })
      res.json({ lists })
    } catch (error) {
      next(error)
    }
  })

  router.get('/lists/:id', requirePermission(PERMISSIONS.PRODUCT_VIEW), async (req, res, next) => {
    try {
      const list = await priceService.getListById(parseUuid(req.params['id'], 'Price list id'))
      res.json({ list })
    } catch (error) {
      next(error)
    }
  })

  router.post('/lists', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const parsed = createListSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid price list data', parsed.error.issues)
      }
      const list = await priceService.createList(parsed.data)
      res.status(201).json({ list })
    } catch (error) {
      next(error)
    }
  })

  router.put('/lists/:id', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const parsed = updateListSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid price list data', parsed.error.issues)
      }
      const list = await priceService.updateList(
        parseUuid(req.params['id'], 'Price list id'),
        parsed.data
      )
      res.json({ list })
    } catch (error) {
      next(error)
    }
  })

  router.delete(
    '/lists/:id',
    requirePermission(PERMISSIONS.PRODUCT_EDIT),
    async (req, res, next) => {
      try {
        const deleted = await priceService.deleteList(parseUuid(req.params['id'], 'Price list id'))
        res.json({ deleted })
      } catch (error) {
        next(error)
      }
    }
  )

  // ---- Price list items ----

  router.put(
    '/lists/:id/items',
    requirePermission(PERMISSIONS.PRODUCT_EDIT),
    async (req, res, next) => {
      try {
        const parsed = setItemsSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid item data', parsed.error.issues)
        }
        const result = await priceService.setItemPrices(
          parseUuid(req.params['id'], 'Price list id'),
          parsed.data.items
        )
        res.json(result)
      } catch (error) {
        next(error)
      }
    }
  )

  router.delete(
    '/lists/:id/items/:variantId',
    requirePermission(PERMISSIONS.PRODUCT_EDIT),
    async (req, res, next) => {
      try {
        const deleted = await priceService.removeItem(
          parseUuid(req.params['id'], 'Price list id'),
          parseUuid(req.params['variantId'], 'Variant id')
        )
        res.json({ deleted })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
