/**
 * Sales method routes — S7-01, design §6.
 *
 * Tenant-owned configuration for how orders are fulfilled: dine-in / takeaway /
 * delivery. Orders reference a method by `code`, so `code` is immutable and unique
 * per tenant. The fiscal columns cross as nullable integers — they are NO-OP in S7
 * (order.fiscal.ts is an identity passthrough) but stored so the override can be
 * wired later without a migration.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { isSalesMethodKind, PERMISSIONS } from '@brewsync/shared'
import { SalesMethodService } from '../services/sales-method.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { badRequest } from '../http-error.js'

const salesMethodKindSchema = z.string().refine(isSalesMethodKind, {
  message: 'kind must be DINE_IN, TAKEAWAY, or DELIVERY',
})

const createSalesMethodSchema = z.object({
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(60),
  kind: salesMethodKindSchema,
  taxRateBp: z.number().int().min(0).max(100_000).optional().nullable(),
  serviceChargeRateBp: z.number().int().min(0).max(100_000).optional().nullable(),
  taxInclusive: z.boolean().optional().nullable(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

const updateSalesMethodSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  taxRateBp: z.number().int().min(0).max(100_000).optional().nullable(),
  serviceChargeRateBp: z.number().int().min(0).max(100_000).optional().nullable(),
  taxInclusive: z.boolean().optional().nullable(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

const salesMethodIdSchema = z.string().uuid()

function parseSalesMethodId(raw: unknown): string {
  const parsed = salesMethodIdSchema.safeParse(raw)
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', 'Sales method id must be a uuid')
  }
  return parsed.data
}

export function createSalesMethodRouter(db: BrewsyncClient): Router {
  const router = Router()
  const service = new SalesMethodService(db)
  const requirePermission = createPermissionMiddleware(db)

  router.get('/', requirePermission(PERMISSIONS.SETTINGS_MANAGE), async (req, res, next) => {
    try {
      const methods = await service.list({
        includeInactive: req.query['includeInactive'] === 'true',
      })
      res.json({ salesMethods: methods })
    } catch (error) {
      next(error)
    }
  })

  router.get('/:id', requirePermission(PERMISSIONS.SETTINGS_MANAGE), async (req, res, next) => {
    try {
      const method = await service.getById(parseSalesMethodId(req.params['id']))
      res.json({ salesMethod: method })
    } catch (error) {
      next(error)
    }
  })

  router.post('/', requirePermission(PERMISSIONS.SETTINGS_MANAGE), async (req, res, next) => {
    try {
      const parsed = createSalesMethodSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid sales method data', parsed.error.issues)
      }
      const method = await service.create(parsed.data)
      res.status(201).json({ salesMethod: method })
    } catch (error) {
      next(error)
    }
  })

  router.put('/:id', requirePermission(PERMISSIONS.SETTINGS_MANAGE), async (req, res, next) => {
    try {
      const parsed = updateSalesMethodSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid sales method data', parsed.error.issues)
      }
      const method = await service.update(parseSalesMethodId(req.params['id']), parsed.data)
      res.json({ salesMethod: method })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/:id', requirePermission(PERMISSIONS.SETTINGS_MANAGE), async (req, res, next) => {
    try {
      const method = await service.deactivate(parseSalesMethodId(req.params['id']))
      res.json({ salesMethod: method })
    } catch (error) {
      next(error)
    }
  })

  return router
}
