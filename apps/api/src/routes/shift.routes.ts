/**
 * Shift routes — S5-06/07, design §14.
 *
 * Thin HTTP layer over `ShiftService`. Open/close/movement are each guarded by
 * the matching SHIFT_* permission (standard #5 — the backend is the security
 * boundary) and Zod-validated; cash amounts cross the wire as decimal strings via
 * `minorUnits` (standard #2). The service owns the ledger, the reconciliation
 * math, and the ShiftOpened/ShiftClosed emits — this file only shapes requests
 * and forwards errors to the shared handler.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { ShiftService } from '../services/shift.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { badRequest } from '../http-error.js'
import { minorUnits } from '../zod-bigint.js'

const uuidSchema = z.string().uuid()

const openSchema = z.object({
  outletId: z.string().uuid(),
  registerId: z.string().min(1).max(120).optional(),
  openingFloatMinor: minorUnits,
})

const movementSchema = z.object({
  type: z.enum(['PAID_IN', 'PAID_OUT', 'DROP']),
  amountMinor: minorUnits,
  reason: z.string().min(1).max(500),
})

const closeSchema = z.object({
  closingCountedCashMinor: minorUnits,
  reason: z.string().min(1).max(500).optional(),
})

function parseId(raw: unknown, what: string): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', `${what} must be a uuid`)
  }
  return parsed.data
}

export function createShiftRouter(db: BrewsyncClient): Router {
  const router = Router()
  const shifts = new ShiftService(db)
  const requirePermission = createPermissionMiddleware(db)

  // ---- Read: the open shift for an outlet/register ----

  router.get('/current', requirePermission(PERMISSIONS.SHIFT_OPEN), async (req, res, next) => {
    try {
      const outletId = req.query['outletId']
      if (typeof outletId !== 'string' || !uuidSchema.safeParse(outletId).success) {
        throw badRequest('VALIDATION_ERROR', 'outletId query param must be a uuid')
      }
      const registerId = typeof req.query['registerId'] === 'string' ? req.query['registerId'] : null
      const shift = await shifts.current(outletId, registerId)
      res.json({ shift })
    } catch (error) {
      next(error)
    }
  })

  // ---- Open (§14.1) ----

  router.post('/', requirePermission(PERMISSIONS.SHIFT_OPEN), async (req, res, next) => {
    try {
      const parsed = openSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid shift', parsed.error.issues)
      }
      const shift = await shifts.open({
        outletId: parsed.data.outletId,
        openingFloatMinor: parsed.data.openingFloatMinor,
        ...(parsed.data.registerId !== undefined ? { registerId: parsed.data.registerId } : {}),
      })
      res.status(201).json({ shift })
    } catch (error) {
      next(error)
    }
  })

  // ---- Manual cash movement (§14.2) ----

  router.post(
    '/:id/movements',
    requirePermission(PERMISSIONS.SHIFT_CASH_MOVEMENT),
    async (req, res, next) => {
      try {
        const parsed = movementSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid cash movement', parsed.error.issues)
        }
        const shift = await shifts.addMovement(parseId(req.params['id'], 'Shift id'), {
          type: parsed.data.type,
          amountMinor: parsed.data.amountMinor,
          reason: parsed.data.reason,
        })
        res.status(201).json({ shift })
      } catch (error) {
        next(error)
      }
    }
  )

  // ---- Close & reconcile (§14.3) ----

  router.post('/:id/close', requirePermission(PERMISSIONS.SHIFT_CLOSE), async (req, res, next) => {
    try {
      const parsed = closeSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid close', parsed.error.issues)
      }
      const shift = await shifts.close(parseId(req.params['id'], 'Shift id'), {
        closingCountedCashMinor: parsed.data.closingCountedCashMinor,
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
      })
      res.json({ shift })
    } catch (error) {
      next(error)
    }
  })

  return router
}
