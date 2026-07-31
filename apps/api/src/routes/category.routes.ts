/**
 * Category routes — S3-01, design §3.1.
 *
 * Categories nest via self-reference and carry defaults (tax rate, KDS station,
 * report group) that flow down to products. The service guards against cycles.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { CategoryService } from '../services/category.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { PERMISSIONS } from '@brewsync/shared'
import { badRequest } from '../http-error.js'

const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, numbers, and hyphens only'),
  parentId: z.string().uuid().optional().nullable(),
  sortOrder: z.number().int().min(0).optional(),
  defaultTaxRateBp: z.number().int().min(0).max(100_000).optional().nullable(),
  defaultStationId: z.string().uuid().optional().nullable(),
  reportGroup: z.string().min(1).max(50).optional().nullable(),
})

const updateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  parentId: z.string().uuid().optional().nullable(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  defaultTaxRateBp: z.number().int().min(0).max(100_000).optional().nullable(),
  defaultStationId: z.string().uuid().optional().nullable(),
  reportGroup: z.string().min(1).max(50).optional().nullable(),
})

const categoryIdSchema = z.string().uuid()

function parseCategoryId(raw: unknown): string {
  const parsed = categoryIdSchema.safeParse(raw)
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', 'Category id must be a uuid')
  }
  return parsed.data
}

export function createCategoryRouter(db: BrewsyncClient): Router {
  const router = Router()
  const categoryService = new CategoryService(db)
  const requirePermission = createPermissionMiddleware(db)

  router.get('/', requirePermission(PERMISSIONS.PRODUCT_VIEW), async (req, res, next) => {
    try {
      const includeInactive = req.query['includeInactive'] === 'true'
      const categories = await categoryService.list({ includeInactive })
      res.json({ categories })
    } catch (error) {
      next(error)
    }
  })

  router.get('/:id', requirePermission(PERMISSIONS.PRODUCT_VIEW), async (req, res, next) => {
    try {
      const category = await categoryService.getById(parseCategoryId(req.params['id']))
      res.json({ category })
    } catch (error) {
      next(error)
    }
  })

  router.get('/:id/defaults', requirePermission(PERMISSIONS.PRODUCT_VIEW), async (req, res, next) => {
    try {
      const defaults = await categoryService.resolveDefaults(parseCategoryId(req.params['id']))
      res.json(defaults)
    } catch (error) {
      next(error)
    }
  })

  router.post('/', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const parsed = createCategorySchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid category data', parsed.error.issues)
      }
      const category = await categoryService.create(parsed.data)
      res.status(201).json({ category })
    } catch (error) {
      next(error)
    }
  })

  router.put('/:id', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const parsed = updateCategorySchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid category data', parsed.error.issues)
      }
      const category = await categoryService.update(parseCategoryId(req.params['id']), parsed.data)
      res.json({ category })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/:id', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const deleted = await categoryService.delete(parseCategoryId(req.params['id']))
      res.json({ deleted })
    } catch (error) {
      next(error)
    }
  })

  return router
}
