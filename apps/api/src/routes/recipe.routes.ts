/**
 * Recipe routes — S6-03, design §3.4 (standards #5).
 *
 * Thin HTTP layer over `RecipeService`, mounted under a variant. Every route is
 * gated on BOTH the `recipe` feature (requireFeature — retail never sees this)
 * and a product permission (requirePermission — the security boundary, standard
 * #5): reads need `product.view`, writes need `product.edit`. Component
 * quantities cross the wire as scaled integers via `zod-bigint`; the service
 * owns validation, the replace-all write, and the explosion graph.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { RecipeService } from '../services/recipe.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { createFeatureMiddleware } from '../middleware/feature.middleware.js'
import { badRequest } from '../http-error.js'
import { positiveScaled } from '../zod-bigint.js'

const uuidSchema = z.string().uuid()

const itemSchema = z.object({
  componentVariantId: z.string().uuid(),
  componentType: z.enum(['INGREDIENT', 'PRODUCT']),
  qtyScaled: positiveScaled,
  recipeUnitId: z.string().uuid(),
  sortOrder: z.number().int().min(0).optional(),
})

const upsertSchema = z.object({
  yieldQtyScaled: positiveScaled.optional(),
  notes: z.string().max(2000).optional(),
  isActive: z.boolean().optional(),
  items: z.array(itemSchema).min(1),
})

function parseVariantId(raw: unknown): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'variantId must be a uuid')
  return parsed.data
}

export function createRecipeRouter(db: BrewsyncClient): Router {
  const router = Router()
  const recipes = new RecipeService(db)
  const requirePermission = createPermissionMiddleware(db)
  const requireFeature = createFeatureMiddleware(db)

  // The recipe feature gates the whole router (standard #5, FE mirror is UX only).
  router.use(requireFeature('recipe'))

  // ---- Read a variant's recipe ----

  router.get(
    '/:variantId/recipe',
    requirePermission(PERMISSIONS.PRODUCT_VIEW),
    async (req, res, next) => {
      try {
        const recipe = await recipes.getForVariant(parseVariantId(req.params['variantId']))
        res.json({ recipe })
      } catch (error) {
        next(error)
      }
    }
  )

  // ---- Create / replace a variant's recipe ----

  router.put(
    '/:variantId/recipe',
    requirePermission(PERMISSIONS.PRODUCT_EDIT),
    async (req, res, next) => {
      try {
        const parsed = upsertSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid recipe', parsed.error.issues)
        }
        const recipe = await recipes.upsert({
          variantId: parseVariantId(req.params['variantId']),
          items: parsed.data.items.map((item) => ({
            componentVariantId: item.componentVariantId,
            componentType: item.componentType,
            qtyScaled: item.qtyScaled,
            recipeUnitId: item.recipeUnitId,
            ...(item.sortOrder !== undefined ? { sortOrder: item.sortOrder } : {}),
          })),
          ...(parsed.data.yieldQtyScaled !== undefined
            ? { yieldQtyScaled: parsed.data.yieldQtyScaled }
            : {}),
          ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
          ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
        })
        res.json({ recipe })
      } catch (error) {
        next(error)
      }
    }
  )

  // ---- Remove a variant's recipe ----

  router.delete(
    '/:variantId/recipe',
    requirePermission(PERMISSIONS.PRODUCT_EDIT),
    async (req, res, next) => {
      try {
        const result = await recipes.remove(parseVariantId(req.params['variantId']))
        res.json(result)
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
