/**
 * Reservation routes — S8-01/02/03/04, design §15 (standard #5).
 *
 * Thin HTTP layer over `ReservationService`. Gated on BOTH the `reservation`
 * feature (requireFeature — an outlet with reservations off never exposes this)
 * and `reservation.manage` (requirePermission — the security boundary, standard
 * #5). The service owns the state machine, the anti double-book check, the
 * deposit-as-credit rule, and the seat → order handoff. Deposit amounts cross the
 * wire as minor-unit decimal strings via `zod-bigint`.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { ReservationService } from '../services/reservation.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { createFeatureMiddleware } from '../middleware/feature.middleware.js'
import { badRequest } from '../http-error.js'
import { minorUnits } from '../zod-bigint.js'

const reservationIdSchema = z.string().uuid()

const createSchema = z.object({
  outletId: z.string().uuid(),
  source: z.enum(['STAFF', 'ONLINE']).optional(),
  customerName: z.string().min(1).max(200),
  customerPhone: z.string().min(1).max(50),
  customerEmail: z.string().email().max(200).optional().nullable(),
  partySize: z.number().int().min(1).max(1000),
  reservedFor: z.coerce.date(),
  durationMin: z.number().int().min(1).max(1440).optional().nullable(),
  tableId: z.string().uuid().optional().nullable(),
  assignedStaffId: z.string().uuid().optional().nullable(),
  depositAmount: minorUnits.optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
})

const updateSchema = z.object({
  customerName: z.string().min(1).max(200).optional(),
  customerPhone: z.string().min(1).max(50).optional(),
  customerEmail: z.string().email().max(200).optional().nullable(),
  partySize: z.number().int().min(1).max(1000).optional(),
  reservedFor: z.coerce.date().optional(),
  durationMin: z.number().int().min(1).max(1440).optional().nullable(),
  tableId: z.string().uuid().optional().nullable(),
  assignedStaffId: z.string().uuid().optional().nullable(),
  depositAmount: minorUnits.optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
})

const cancelSchema = z.object({
  reason: z.string().max(500).optional(),
})

function parseReservationId(raw: unknown): string {
  const parsed = reservationIdSchema.safeParse(raw)
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'Reservation id must be a uuid')
  return parsed.data
}

export function createReservationRouter(db: BrewsyncClient): Router {
  const router = Router()
  const service = new ReservationService(db)
  const requirePermission = createPermissionMiddleware(db)
  const requireFeature = createFeatureMiddleware(db)

  // The reservation feature gates the whole router (standard #5; FE mirror is UX only).
  router.use(requireFeature('reservation'))
  router.use(requirePermission(PERMISSIONS.RESERVATION_MANAGE))

  // ---- Reads ----

  router.get('/', async (req, res, next) => {
    try {
      const status = req.query['status']
      const reservations = await service.list({
        ...(typeof req.query['outletId'] === 'string' ? { outletId: req.query['outletId'] } : {}),
        ...(typeof req.query['tableId'] === 'string' ? { tableId: req.query['tableId'] } : {}),
        ...(typeof status === 'string' ? { status: status as never } : {}),
      })
      res.json({ reservations })
    } catch (error) {
      next(error)
    }
  })

  router.get('/:id', async (req, res, next) => {
    try {
      const reservation = await service.getById(parseReservationId(req.params['id']))
      res.json({ reservation })
    } catch (error) {
      next(error)
    }
  })

  // ---- Create / edit ----

  router.post('/', async (req, res, next) => {
    try {
      const parsed = createSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid reservation', parsed.error.issues)
      }
      const d = parsed.data
      const reservation = await service.create({
        outletId: d.outletId,
        customerName: d.customerName,
        customerPhone: d.customerPhone,
        partySize: d.partySize,
        reservedFor: d.reservedFor,
        ...(d.source !== undefined ? { source: d.source } : {}),
        ...(d.customerEmail !== undefined ? { customerEmail: d.customerEmail } : {}),
        ...(d.durationMin !== undefined ? { durationMin: d.durationMin } : {}),
        ...(d.tableId !== undefined ? { tableId: d.tableId } : {}),
        ...(d.assignedStaffId !== undefined ? { assignedStaffId: d.assignedStaffId } : {}),
        ...(d.depositAmount !== undefined ? { depositAmount: d.depositAmount } : {}),
        ...(d.notes !== undefined ? { notes: d.notes } : {}),
      })
      res.status(201).json({ reservation })
    } catch (error) {
      next(error)
    }
  })

  router.put('/:id', async (req, res, next) => {
    try {
      const parsed = updateSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid reservation', parsed.error.issues)
      }
      const d = parsed.data
      const reservation = await service.update(parseReservationId(req.params['id']), {
        ...(d.customerName !== undefined ? { customerName: d.customerName } : {}),
        ...(d.customerPhone !== undefined ? { customerPhone: d.customerPhone } : {}),
        ...(d.customerEmail !== undefined ? { customerEmail: d.customerEmail } : {}),
        ...(d.partySize !== undefined ? { partySize: d.partySize } : {}),
        ...(d.reservedFor !== undefined ? { reservedFor: d.reservedFor } : {}),
        ...(d.durationMin !== undefined ? { durationMin: d.durationMin } : {}),
        ...(d.tableId !== undefined ? { tableId: d.tableId } : {}),
        ...(d.assignedStaffId !== undefined ? { assignedStaffId: d.assignedStaffId } : {}),
        ...(d.depositAmount !== undefined ? { depositAmount: d.depositAmount } : {}),
        ...(d.notes !== undefined ? { notes: d.notes } : {}),
      })
      res.json({ reservation })
    } catch (error) {
      next(error)
    }
  })

  // ---- Lifecycle transitions ----

  router.post('/:id/confirm', async (req, res, next) => {
    try {
      const reservation = await service.confirm(parseReservationId(req.params['id']))
      res.json({ reservation })
    } catch (error) {
      next(error)
    }
  })

  router.post('/:id/seat', async (req, res, next) => {
    try {
      const reservation = await service.seat(parseReservationId(req.params['id']))
      res.json({ reservation })
    } catch (error) {
      next(error)
    }
  })

  router.post('/:id/no-show', async (req, res, next) => {
    try {
      const reservation = await service.noShow(parseReservationId(req.params['id']))
      res.json({ reservation })
    } catch (error) {
      next(error)
    }
  })

  router.post('/:id/cancel', async (req, res, next) => {
    try {
      const parsed = cancelSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid cancellation', parsed.error.issues)
      }
      const reservation = await service.cancel(
        parseReservationId(req.params['id']),
        parsed.data.reason
      )
      res.json({ reservation })
    } catch (error) {
      next(error)
    }
  })

  return router
}
