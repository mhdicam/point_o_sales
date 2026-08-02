/**
 * KDS routes — S7-04/05, design §5.5.
 *
 * Two surfaces, both gated on the `kds` feature toggle (standard #5):
 *
 *   /stations       — prep-station config. STATION_MANAGE.
 *   /kds/board       — the live kitchen board + lane bumps. KDS_BUMP.
 *
 * Stations are outlet-owned master data; the board is a projection over routed
 * order lines. Lane moves validate through the KDS state machine — an illegal
 * bump surfaces as 409 via the shared error handler.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { StationService } from '../services/station.service.js'
import { KdsService } from '../services/kds.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { createFeatureMiddleware } from '../middleware/feature.middleware.js'
import { badRequest } from '../http-error.js'

const uuid = z.string().uuid()
const kdsStatusSchema = z.enum(['QUEUED', 'PREPARING', 'READY', 'SERVED', 'VOID'])

const createStationSchema = z.object({
  outletId: uuid,
  name: z.string().min(1).max(60),
  sortOrder: z.number().int().optional(),
})

const updateStationSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

const setKdsStatusSchema = z.object({ status: kdsStatusSchema })

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

export function createKdsRouter(db: BrewsyncClient): Router {
  const router = Router()
  const stations = new StationService(db)
  const kds = new KdsService(db)
  const requirePermission = createPermissionMiddleware(db)
  const requireFeature = createFeatureMiddleware(db)

  // KDS feature gates every route below.
  router.use(requireFeature('kds'))

  // --- Stations (config) ---------------------------------------------------

  router.get('/stations', requirePermission(PERMISSIONS.STATION_MANAGE), async (req, res, next) => {
    try {
      const list = await stations.list(parseOutletId(req.query['outletId']), {
        includeInactive: req.query['includeInactive'] === 'true',
      })
      res.json({ stations: list })
    } catch (error) {
      next(error)
    }
  })

  router.post('/stations', requirePermission(PERMISSIONS.STATION_MANAGE), async (req, res, next) => {
    try {
      const parsed = createStationSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid station data', parsed.error.issues)
      }
      const station = await stations.create(parsed.data)
      res.status(201).json({ station })
    } catch (error) {
      next(error)
    }
  })

  router.put(
    '/stations/:id',
    requirePermission(PERMISSIONS.STATION_MANAGE),
    async (req, res, next) => {
      try {
        const parsed = updateStationSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid station data', parsed.error.issues)
        }
        const station = await stations.update(parseId(req.params['id'], 'Station id'), parsed.data)
        res.json({ station })
      } catch (error) {
        next(error)
      }
    },
  )

  router.delete(
    '/stations/:id',
    requirePermission(PERMISSIONS.STATION_MANAGE),
    async (req, res, next) => {
      try {
        const station = await stations.deactivate(parseId(req.params['id'], 'Station id'))
        res.json({ station })
      } catch (error) {
        next(error)
      }
    },
  )

  // --- Board (kitchen) -----------------------------------------------------

  router.get('/kds/board', requirePermission(PERMISSIONS.KDS_BUMP), async (req, res, next) => {
    try {
      const board = await kds.board(parseOutletId(req.query['outletId']))
      res.json(board)
    } catch (error) {
      next(error)
    }
  })

  router.post(
    '/kds/items/:id/status',
    requirePermission(PERMISSIONS.KDS_BUMP),
    async (req, res, next) => {
      try {
        const parsed = setKdsStatusSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid KDS status', parsed.error.issues)
        }
        const line = await kds.setStatus(parseId(req.params['id'], 'KDS line id'), parsed.data.status)
        res.json({ line })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
