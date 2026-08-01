/**
 * Product routes — S3-03, design §3.3.
 *
 * Products, variants and images are created atomically. Three invariants are
 * enforced in the service layer:
 * - Every product ≥ 1 variant.
 * - Exactly one isDefault variant per product.
 * - At most one isCover image per product (and exactly one when images exist).
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

const createImageSchema = z.object({
  url: z.string().url().max(500),
  alt: z.string().max(200).optional().nullable(),
  isCover: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
})

const updateImageSchema = z.object({
  url: z.string().url().max(500).optional(),
  alt: z.string().max(200).optional().nullable(),
  isCover: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
})

const reorderImagesSchema = z.object({
  imageIds: z.array(z.string().uuid()).min(1),
})

const createProductSchema = z.object({
  categoryId: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  description: z.string().max(2000).optional().nullable(),
  fulfillmentType: fulfillmentTypeSchema.optional(),
  sortOrder: z.number().int().min(0).optional(),
  variants: z.array(createVariantSchema).min(1, 'A product must have at least one variant'),
  images: z.array(createImageSchema).optional(),
})

const updateProductSchema = z.object({
  categoryId: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(2000).optional().nullable(),
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

function parseImageId(raw: unknown): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', 'Image id must be a uuid')
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

  // ---- Image routes ----

  router.get(
    '/:productId/images',
    requirePermission(PERMISSIONS.PRODUCT_VIEW),
    async (req, res, next) => {
      try {
        const images = await productService.listImages(parseProductId(req.params['productId']))
        res.json({ images })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/:productId/images',
    requirePermission(PERMISSIONS.PRODUCT_EDIT),
    async (req, res, next) => {
      try {
        const parsed = createImageSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid image data', parsed.error.issues)
        }
        const image = await productService.addImage(
          parseProductId(req.params['productId']),
          parsed.data
        )
        res.status(201).json({ image })
      } catch (error) {
        next(error)
      }
    }
  )

  // PUT, not PATCH: the body is the complete new order. The service refuses a
  // partial list rather than interleaving the omitted images.
  router.put(
    '/:productId/images/order',
    requirePermission(PERMISSIONS.PRODUCT_EDIT),
    async (req, res, next) => {
      try {
        const parsed = reorderImagesSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid image order', parsed.error.issues)
        }
        const images = await productService.reorderImages(
          parseProductId(req.params['productId']),
          parsed.data.imageIds
        )
        res.json({ images })
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

/**
 * Image router — mounts at `/images` for the same reason the variant router does:
 * an image id is globally unique, so addressing it does not need the product in
 * the path. Collection operations (list, add, reorder) stay under the product
 * because they are scoped to one gallery.
 */
export function createImageRouter(db: BrewsyncClient): Router {
  const router = Router()
  const productService = new ProductService(db)
  const requirePermission = createPermissionMiddleware(db)

  router.put('/:id', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const parsed = updateImageSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid image data', parsed.error.issues)
      }
      const image = await productService.updateImage(parseImageId(req.params['id']), parsed.data)
      res.json({ image })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/:id', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const deleted = await productService.deleteImage(parseImageId(req.params['id']))
      res.json({ deleted })
    } catch (error) {
      next(error)
    }
  })

  return router
}
