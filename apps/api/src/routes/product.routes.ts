/**
 * Product routes — S3-03, design §3.3.
 *
 * Products and variants are created atomically. Two invariants are enforced:
 * - Every product ≥ 1 variant.
 * - Exactly one isDefault variant per product.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { ProductService } from '../services/product.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { PERMISSIONS } from '@brewsync/shared'
import { badRequest } from '../http-error.js'
import { minorUnits } from '../zod-bigint.js'

const fulfillmentTypeSchema = z.enum(['STOCKED', 'MADE_TO_ORDER', 'SERVICE'])

const createVariantSchema = z.object({
  sku: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  barcode: z.string().min(1).max(100).optional().nullable(),
  basePrice: minorUnits.optional(),
  fulfillmentType: fulfillmentTypeSchema.optional().nullable(),
  sellUnitId: z.string().uuid().optional().nullable(),
  stockUnitId: z.string().uuid().optional().nullable(),
  serviceDurationMin: z.number().int().min(1).optional().nullable(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
})

const createProductSchema = z.object({
  categoryId: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  description: z.string().max(2000).optional().nullable(),
  imageUrl: z.string().url().max(500).optional().nullable(),
  fulfillmentType: fulfillmentTypeSchema.optional(),
  sortOrder: z.number().int().min(0).optional(),
  variants: z.array(createVariantSchema).min(1, 'A product must have at least one variant'),
})

const updateProductSchema = z.object({
  categoryId: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(2000).optional().nullable(),
  imageUrl: z.string().url().max(500).optional().nullable(),
  fulfillmentType: fulfillmentTypeSchema.optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
})

const updateVariantSchema = z.object({
  sku: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200).optional(),
  barcode: z.string().min(1).max(100).optional().nullable(),
  basePrice: minorUnits.optional(),
  fulfillmentType: fulfillmentTypeSchema.optional().nullable(),
  sellUnitId: z.string().uuid().optional().nullable(),
  stockUnitId: z.string().uuid().optional().nullable(),
  serviceDurationMin: z.number().int().min(1).optional().nullable(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
})

const uuidSchema = z.string().uuid()

function parseProductId(raw: unknown): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', 'Product id must be a uuid')
  }
  return parsed.data
}

function parseVariantId(raw: unknown): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', 'Variant id must be a uuid')
  }
  return parsed.data
}

export function createProductRouter(db: BrewsyncClient): Router {
  const router = Router()
  const productService = new ProductService(db)
  const requirePermission = createPermissionMiddleware(db)

  // ---- Product routes ----

  router.get('/', requirePermission(PERMISSIONS.PRODUCT_VIEW), async (req, res, next) => {
    try {
      const categoryId = req.query['categoryId']
      const products = await productService.list({
        ...(typeof categoryId === 'string' && uuidSchema.safeParse(categoryId).success
          ? { categoryId }
          : {}),
        includeInactive: req.query['includeInactive'] === 'true',
      })
      res.json({ products })
    } catch (error) {
      next(error)
    }
  })

  router.get('/:id', requirePermission(PERMISSIONS.PRODUCT_VIEW), async (req, res, next) => {
    try {
      const product = await productService.getById(parseProductId(req.params['id']))
      res.json({ product })
    } catch (error) {
      next(error)
    }
  })

  router.post('/', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const parsed = createProductSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid product data', parsed.error.issues)
      }
      const product = await productService.create(parsed.data)
      res.status(201).json({ product })
    } catch (error) {
      next(error)
    }
  })

  router.put('/:id', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const parsed = updateProductSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid product data', parsed.error.issues)
      }
      const product = await productService.update(parseProductId(req.params['id']), parsed.data)
      res.json({ product })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/:id', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const deleted = await productService.delete(parseProductId(req.params['id']))
      res.json({ deleted })
    } catch (error) {
      next(error)
    }
  })

  // ---- Variant routes ----

  router.get(
    '/:productId/variants',
    requirePermission(PERMISSIONS.PRODUCT_VIEW),
    async (req, res, next) => {
      try {
        const variants = await productService.listVariants(
          parseProductId(req.params['productId']),
          { includeInactive: req.query['includeInactive'] === 'true' }
        )
        res.json({ variants })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/:productId/variants',
    requirePermission(PERMISSIONS.PRODUCT_EDIT),
    async (req, res, next) => {
      try {
        const parsed = createVariantSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid variant data', parsed.error.issues)
        }
        const variant = await productService.createVariant(
          parseProductId(req.params['productId']),
          parsed.data
        )
        res.status(201).json({ variant })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}

/**
 * Variant router — separate from product router so it can mount at `/variants`
 * for variant-by-id operations without nesting under `/products/:id/variants/:id`.
 */
export function createVariantRouter(db: BrewsyncClient): Router {
  const router = Router()
  const productService = new ProductService(db)
  const requirePermission = createPermissionMiddleware(db)

  router.get('/:id', requirePermission(PERMISSIONS.PRODUCT_VIEW), async (req, res, next) => {
    try {
      const variant = await productService.getVariantById(parseVariantId(req.params['id']))
      res.json({ variant })
    } catch (error) {
      next(error)
    }
  })

  router.put('/:id', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const parsed = updateVariantSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid variant data', parsed.error.issues)
      }
      const variant = await productService.updateVariant(parseVariantId(req.params['id']), parsed.data)
      res.json({ variant })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/:id', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const deleted = await productService.deleteVariant(parseVariantId(req.params['id']))
      res.json({ deleted })
    } catch (error) {
      next(error)
    }
  })

  return router
}
