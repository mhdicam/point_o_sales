/**
 * Modifier routes — S3-04, design §3.4.
 *
 * The whole router sits behind `features.modifiers` (standard #5): an outlet that
 * does not do modifiers gets 403 on every path here, not a per-route decision
 * someone can forget. Feature guard runs before the permission guard — "this
 * tenant does not do modifiers at all" is a clearer answer than "you may not edit
 * them", and it skips a permission lookup for an unbought capability.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { ModifierService } from '../services/modifier.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { createFeatureMiddleware } from '../middleware/feature.middleware.js'
import { PERMISSIONS } from '@brewsync/shared'
import { badRequest } from '../http-error.js'
import { signedMinorUnits } from '../zod-bigint.js'

const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  minSelect: z.number().int().min(0).max(50).optional(),
  maxSelect: z.number().int().min(0).max(50).optional().nullable(),
  isRequired: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
})

const updateGroupSchema = createGroupSchema.partial().extend({
  isActive: z.boolean().optional(),
})

const createModifierSchema = z.object({
  name: z.string().min(1).max(100),
  // Signed: a negative delta ("no ice, −1000") is a legitimate option.
  priceDelta: signedMinorUnits.optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
})

const updateModifierSchema = createModifierSchema.partial().extend({
  isActive: z.boolean().optional(),
})

const attachSchema = z.object({
  groupId: z.string().uuid(),
  sortOrder: z.number().int().min(0).optional(),
})

const uuidSchema = z.string().uuid()

function parseUuid(raw: unknown, label: string): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', `${label} must be a uuid`)
  }
  return parsed.data
}

export function createModifierRouter(db: BrewsyncClient): Router {
  const router = Router()
  const modifierService = new ModifierService(db)
  const requirePermission = createPermissionMiddleware(db)
  const requireFeature = createFeatureMiddleware(db)

  // Applies to every route below, including ones added later.
  router.use(requireFeature('modifiers'))

  // ---- Groups ----

  router.get('/groups', requirePermission(PERMISSIONS.PRODUCT_VIEW), async (req, res, next) => {
    try {
      const groups = await modifierService.listGroups({
        includeInactive: req.query['includeInactive'] === 'true',
      })
      res.json({ groups })
    } catch (error) {
      next(error)
    }
  })

  router.get(
    '/groups/:id',
    requirePermission(PERMISSIONS.PRODUCT_VIEW),
    async (req, res, next) => {
      try {
        const group = await modifierService.getGroupById(parseUuid(req.params['id'], 'Group id'))
        res.json({ group })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post('/groups', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const parsed = createGroupSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid group data', parsed.error.issues)
      }
      const group = await modifierService.createGroup(parsed.data)
      res.status(201).json({ group })
    } catch (error) {
      next(error)
    }
  })

  router.put(
    '/groups/:id',
    requirePermission(PERMISSIONS.PRODUCT_EDIT),
    async (req, res, next) => {
      try {
        const parsed = updateGroupSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid group data', parsed.error.issues)
        }
        const group = await modifierService.updateGroup(
          parseUuid(req.params['id'], 'Group id'),
          parsed.data
        )
        res.json({ group })
      } catch (error) {
        next(error)
      }
    }
  )

  router.delete(
    '/groups/:id',
    requirePermission(PERMISSIONS.PRODUCT_EDIT),
    async (req, res, next) => {
      try {
        const deleted = await modifierService.deleteGroup(parseUuid(req.params['id'], 'Group id'))
        res.json({ deleted })
      } catch (error) {
        next(error)
      }
    }
  )

  // ---- Options within a group ----

  router.post(
    '/groups/:groupId/modifiers',
    requirePermission(PERMISSIONS.PRODUCT_EDIT),
    async (req, res, next) => {
      try {
        const parsed = createModifierSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid modifier data', parsed.error.issues)
        }
        const modifier = await modifierService.createModifier(
          parseUuid(req.params['groupId'], 'Group id'),
          parsed.data
        )
        res.status(201).json({ modifier })
      } catch (error) {
        next(error)
      }
    }
  )

  router.put('/:id', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const parsed = updateModifierSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid modifier data', parsed.error.issues)
      }
      const modifier = await modifierService.updateModifier(
        parseUuid(req.params['id'], 'Modifier id'),
        parsed.data
      )
      res.json({ modifier })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/:id', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const deleted = await modifierService.deleteModifier(
        parseUuid(req.params['id'], 'Modifier id')
      )
      res.json({ deleted })
    } catch (error) {
      next(error)
    }
  })

  return router
}

/**
 * Product-side attachment routes, mounted under `/products` so the URL reads
 * `/products/:id/modifier-groups`. Same feature gate.
 */
export function createProductModifierRouter(db: BrewsyncClient): Router {
  const router = Router()
  const modifierService = new ModifierService(db)
  const requirePermission = createPermissionMiddleware(db)
  const requireFeature = createFeatureMiddleware(db)

  router.use(requireFeature('modifiers'))

  router.get(
    '/:productId/modifier-groups',
    requirePermission(PERMISSIONS.PRODUCT_VIEW),
    async (req, res, next) => {
      try {
        const groups = await modifierService.listForProduct(
          parseUuid(req.params['productId'], 'Product id')
        )
        res.json({ groups })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/:productId/modifier-groups',
    requirePermission(PERMISSIONS.PRODUCT_EDIT),
    async (req, res, next) => {
      try {
        const parsed = attachSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid attachment data', parsed.error.issues)
        }
        const attachment = await modifierService.attachToProduct(
          parseUuid(req.params['productId'], 'Product id'),
          parsed.data.groupId,
          parsed.data.sortOrder ?? 0
        )
        res.status(201).json({ attachment })
      } catch (error) {
        next(error)
      }
    }
  )

  router.delete(
    '/:productId/modifier-groups/:groupId',
    requirePermission(PERMISSIONS.PRODUCT_EDIT),
    async (req, res, next) => {
      try {
        const deleted = await modifierService.detachFromProduct(
          parseUuid(req.params['productId'], 'Product id'),
          parseUuid(req.params['groupId'], 'Group id')
        )
        res.json({ deleted })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
