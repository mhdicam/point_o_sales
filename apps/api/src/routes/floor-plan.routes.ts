/**
 * Floor plan routes — S7-02, design §5.4.
 *
 * Areas and tables for dine-in outlets. Everything here is gated on BOTH the
 * `tables` feature toggle (requireFeature) and the TABLE_MANAGE permission
 * (standard #5: backend is the security boundary). Outlets with `features.tables`
 * off — retail, service, delivery-only — get a 403 and never see this surface.
 *
 * Status transitions go through the state machine (table.state.ts); an illegal
 * move surfaces as 409 via the shared error handler.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { AreaService } from '../services/area.service.js'
import { TableService } from '../services/table.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { createFeatureMiddleware } from '../middleware/feature.middleware.js'
import { badRequest } from '../http-error.js'

const areaKindSchema = z.enum(['AREA', 'FLOOR'])
const tableStatusSchema = z.enum(['EMPTY', 'OCCUPIED', 'RESERVED', 'DIRTY'])
const uuid = z.string().uuid()

const createAreaSchema = z.object({
  outletId: uuid,
  parentId: uuid.optional().nullable(),
  kind: areaKindSchema,
  name: z.string().min(1).max(60),
  sortOrder: z.number().int().optional(),
})

const updateAreaSchema = z.object({
  parentId: uuid.optional().nullable(),
  name: z.string().min(1).max(60).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

const createTableSchema = z.object({
  outletId: uuid,
  areaId: uuid.optional().nullable(),
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(60),
  capacity: z.number().int().min(1).max(100).optional().nullable(),
  sortOrder: z.number().int().optional(),
})

const updateTableSchema = z.object({
  areaId: uuid.optional().nullable(),
  name: z.string().min(1).max(60).optional(),
  capacity: z.number().int().min(1).max(100).optional().nullable(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

const setStatusSchema = z.object({ status: tableStatusSchema })

function parseId(raw: unknown, label: string): string {
  const parsed = uuid.safeParse(raw)
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', `${label} must be a uuid`)
  return parsed.data
}

function parseOutletId(raw: unknown): string {
  const parsed = uuid.safeParse(raw)
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'outletId query param must be a uuid')
  return parsed.data
}

export function createFloorPlanRouter(db: BrewsyncClient): Router {
  const router = Router()
  const areas = new AreaService(db)
  const tables = new TableService(db)
  const requirePermission = createPermissionMiddleware(db)
  const requireFeature = createFeatureMiddleware(db)

  // Both guards apply to every route below.
  router.use(requireFeature('tables'), requirePermission(PERMISSIONS.TABLE_MANAGE))

  // --- Areas ---------------------------------------------------------------

  router.get('/areas', async (req, res, next) => {
    try {
      const list = await areas.list(parseOutletId(req.query['outletId']), {
        includeInactive: req.query['includeInactive'] === 'true',
      })
      res.json({ areas: list })
    } catch (error) {
      next(error)
    }
  })

  router.post('/areas', async (req, res, next) => {
    try {
      const parsed = createAreaSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid area data', parsed.error.issues)
      }
      const area = await areas.create(parsed.data)
      res.status(201).json({ area })
    } catch (error) {
      next(error)
    }
  })

  router.put('/areas/:id', async (req, res, next) => {
    try {
      const parsed = updateAreaSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid area data', parsed.error.issues)
      }
      const area = await areas.update(parseId(req.params['id'], 'Area id'), parsed.data)
      res.json({ area })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/areas/:id', async (req, res, next) => {
    try {
      const area = await areas.deactivate(parseId(req.params['id'], 'Area id'))
      res.json({ area })
    } catch (error) {
      next(error)
    }
  })

  // --- Tables --------------------------------------------------------------

  router.get('/tables', async (req, res, next) => {
    try {
      const list = await tables.list(parseOutletId(req.query['outletId']), {
        includeInactive: req.query['includeInactive'] === 'true',
        ...(typeof req.query['areaId'] === 'string'
          ? { areaId: parseId(req.query['areaId'], 'Area id') }
          : {}),
      })
      res.json({ tables: list })
    } catch (error) {
      next(error)
    }
  })

  router.post('/tables', async (req, res, next) => {
    try {
      const parsed = createTableSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid table data', parsed.error.issues)
      }
      const table = await tables.create(parsed.data)
      res.status(201).json({ table })
    } catch (error) {
      next(error)
    }
  })

  router.put('/tables/:id', async (req, res, next) => {
    try {
      const parsed = updateTableSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid table data', parsed.error.issues)
      }
      const table = await tables.update(parseId(req.params['id'], 'Table id'), parsed.data)
      res.json({ table })
    } catch (error) {
      next(error)
    }
  })

  router.post('/tables/:id/status', async (req, res, next) => {
    try {
      const parsed = setStatusSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid status', parsed.error.issues)
      }
      const table = await tables.setStatus(parseId(req.params['id'], 'Table id'), parsed.data.status)
      res.json({ table })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/tables/:id', async (req, res, next) => {
    try {
      const table = await tables.deactivate(parseId(req.params['id'], 'Table id'))
      res.json({ table })
    } catch (error) {
      next(error)
    }
  })

  return router
}
