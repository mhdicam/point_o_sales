/**
 * Unit routes — S3-02, design §3.2.
 *
 * `factor` crosses the wire as a decimal string, not a number: it is a BigInt
 * scaled by 1e6, and JSON numbers lose precision past 2^53. Clients send strings
 * too — Zod coerces and validates the range here so the service only sees bigint.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { UnitService } from '../services/unit.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { PERMISSIONS } from '@brewsync/shared'
import { badRequest } from '../http-error.js'
import { positiveScaled } from '../zod-bigint.js'

const unitDimensionSchema = z.enum(['COUNT', 'WEIGHT', 'VOLUME', 'LENGTH', 'TIME'])

const createUnitSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(60),
  dimension: unitDimensionSchema,
  baseUnitId: z.string().uuid().optional().nullable(),
  factor: positiveScaled.optional(),
})

const updateUnitSchema = z.object({
  code: z.string().min(1).max(20).optional(),
  name: z.string().min(1).max(60).optional(),
  baseUnitId: z.string().uuid().optional().nullable(),
  factor: positiveScaled.optional(),
  isActive: z.boolean().optional(),
})

const unitIdSchema = z.string().uuid()

function parseUnitId(raw: unknown): string {
  const parsed = unitIdSchema.safeParse(raw)
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', 'Unit id must be a uuid')
  }
  return parsed.data
}

export function createUnitRouter(db: BrewsyncClient): Router {
  const router = Router()
  const unitService = new UnitService(db)
  const requirePermission = createPermissionMiddleware(db)

  router.get('/', requirePermission(PERMISSIONS.PRODUCT_VIEW), async (req, res, next) => {
    try {
      const dimension = unitDimensionSchema.safeParse(req.query['dimension'])
      const units = await unitService.list({
        ...(dimension.success && { dimension: dimension.data }),
        includeInactive: req.query['includeInactive'] === 'true',
      })
      res.json({ units })
    } catch (error) {
      next(error)
    }
  })

  router.get('/:id', requirePermission(PERMISSIONS.PRODUCT_VIEW), async (req, res, next) => {
    try {
      const unit = await unitService.getById(parseUnitId(req.params['id']))
      res.json({ unit })
    } catch (error) {
      next(error)
    }
  })

  router.post('/', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const parsed = createUnitSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid unit data', parsed.error.issues)
      }
      const unit = await unitService.create(parsed.data)
      res.status(201).json({ unit })
    } catch (error) {
      next(error)
    }
  })

  router.put('/:id', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const parsed = updateUnitSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid unit data', parsed.error.issues)
      }
      const unit = await unitService.update(parseUnitId(req.params['id']), parsed.data)
      res.json({ unit })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/:id', requirePermission(PERMISSIONS.PRODUCT_EDIT), async (req, res, next) => {
    try {
      const deleted = await unitService.delete(parseUnitId(req.params['id']))
      res.json({ deleted })
    } catch (error) {
      next(error)
    }
  })

  return router
}
