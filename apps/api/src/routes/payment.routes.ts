/**
 * Payment routes — S5-01..05, design §7.
 *
 * Thin HTTP layer over `PaymentService`. Every mutation is permission-guarded
 * (standard #5 — the backend is the security boundary) and Zod-validated; money
 * crosses the wire as decimal strings via `minorUnits` (standard #2), and the
 * app's global `json replacer` serializes BigInt back the same way. The service
 * owns the settlement math, the state machine hop to PAID, and the outbox emit —
 * this file only shapes requests and forwards errors to the shared handler.
 *
 * Reads (methods, an order's bills) sit behind PAYMENT_ACCEPT: seeing what is
 * owed is part of taking payment. Splitting a bill and accepting a tender are
 * PAYMENT_ACCEPT; a refund is the stricter PAYMENT_REFUND.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { PaymentService } from '../services/payment.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { badRequest } from '../http-error.js'
import { minorUnits } from '../zod-bigint.js'

const uuidSchema = z.string().uuid()

const acceptSchema = z.object({
  methodId: z.string().uuid(),
  amountMinor: minorUnits,
  refNo: z.string().min(1).max(120).optional(),
})

/** A split is exactly one of an even N-way split or explicit non-negative weights. */
const splitSchema = z.union([
  z.object({ mode: z.literal('even'), parts: z.number().int().min(2).max(50) }),
  z.object({ mode: z.literal('weights'), weights: z.array(minorUnits).min(2).max(50) }),
])

const refundSchema = z.object({
  methodId: z.string().uuid(),
  amountMinor: minorUnits,
  reason: z.string().min(1).max(500),
  refNo: z.string().min(1).max(120).optional(),
})

function parseId(raw: unknown, what: string): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', `${what} must be a uuid`)
  }
  return parsed.data
}

export function createPaymentRouter(db: BrewsyncClient): Router {
  const router = Router()
  const payments = new PaymentService(db)
  const requirePermission = createPermissionMiddleware(db)

  // ---- Reads ----

  router.get('/methods', requirePermission(PERMISSIONS.PAYMENT_ACCEPT), async (_req, res, next) => {
    try {
      const methods = await payments.listMethods()
      res.json({ methods })
    } catch (error) {
      next(error)
    }
  })

  router.get(
    '/orders/:orderId/bills',
    requirePermission(PERMISSIONS.PAYMENT_ACCEPT),
    async (req, res, next) => {
      try {
        const bills = await payments.listBills(parseId(req.params['orderId'], 'Order id'))
        res.json({ bills })
      } catch (error) {
        next(error)
      }
    }
  )

  // ---- Split bill (§7.3) ----

  router.post(
    '/orders/:orderId/split',
    requirePermission(PERMISSIONS.PAYMENT_ACCEPT),
    async (req, res, next) => {
      try {
        const parsed = splitSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid split', parsed.error.issues)
        }
        const bills = await payments.split(parseId(req.params['orderId'], 'Order id'), parsed.data)
        res.status(201).json({ bills })
      } catch (error) {
        next(error)
      }
    }
  )

  // ---- Accept payment (§7.1/§7.2) ----

  router.post(
    '/bills/:billId',
    requirePermission(PERMISSIONS.PAYMENT_ACCEPT),
    async (req, res, next) => {
      try {
        const parsed = acceptSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid payment', parsed.error.issues)
        }
        const bill = await payments.accept(parseId(req.params['billId'], 'Bill id'), {
          methodId: parsed.data.methodId,
          amountMinor: parsed.data.amountMinor,
          ...(parsed.data.refNo !== undefined ? { refNo: parsed.data.refNo } : {}),
        })
        res.status(201).json({ bill })
      } catch (error) {
        next(error)
      }
    }
  )

  // ---- Refund (§7.4) — stricter permission ----

  router.post(
    '/bills/:billId/refund',
    requirePermission(PERMISSIONS.PAYMENT_REFUND),
    async (req, res, next) => {
      try {
        const parsed = refundSchema.safeParse(req.body)
        if (!parsed.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid refund', parsed.error.issues)
        }
        const bill = await payments.refund(parseId(req.params['billId'], 'Bill id'), {
          methodId: parsed.data.methodId,
          amountMinor: parsed.data.amountMinor,
          reason: parsed.data.reason,
          ...(parsed.data.refNo !== undefined ? { refNo: parsed.data.refNo } : {}),
        })
        res.status(201).json({ bill })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
