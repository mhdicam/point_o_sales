/**
 * Supplier routes — S6-05, design §4.4 (standard #5).
 *
 * Thin HTTP layer over `SupplierService`. Gated on BOTH the `purchasing` feature
 * (requireFeature — a service-only outlet leaves it off and never sees suppliers)
 * and the `supplier.manage` permission (requirePermission — the security
 * boundary, standard #5). `code` is set at create and frozen; a delete
 * deactivates rather than removes so PO history stays resolvable.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { SupplierService } from '../services/supplier.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { createFeatureMiddleware } from '../middleware/feature.middleware.js'
import { badRequest } from '../http-error.js'

const supplierIdSchema = z.string().uuid()

const createSupplierSchema = z.object({
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(120),
  contactName: z.string().max(120).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  email: z.string().email().max(120).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  taxId: z.string().max(40).optional().nullable(),
  paymentTermDays: z.number().int().min(0).max(365).optional(),
  defaultCurrency: z.string().min(3).max(3).optional(),
  isActive: z.boolean().optional(),
  notes: z.string().max(2000).optional().nullable(),
})

const updateSupplierSchema = createSupplierSchema.partial().omit({ code: true })

function parseSupplierId(raw: unknown): string {
  const parsed = supplierIdSchema.safeParse(raw)
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'Supplier id must be a uuid')
  return parsed.data
}

export function createSupplierRouter(db: BrewsyncClient): Router {
  const router = Router()
  const service = new SupplierService(db)
  const requirePermission = createPermissionMiddleware(db)
  const requireFeature = createFeatureMiddleware(db)

  // The purchasing feature gates the whole router (standard #5, FE mirror is UX only).
  router.use(requireFeature('purchasing'))

  router.get('/', requirePermission(PERMISSIONS.SUPPLIER_MANAGE), async (req, res, next) => {
    try {
      const suppliers = await service.list({
        includeInactive: req.query['includeInactive'] === 'true',
      })
      res.json({ suppliers })
    } catch (error) {
      next(error)
    }
  })

  router.get('/:id', requirePermission(PERMISSIONS.SUPPLIER_MANAGE), async (req, res, next) => {
    try {
      const supplier = await service.getById(parseSupplierId(req.params['id']))
      res.json({ supplier })
    } catch (error) {
      next(error)
    }
  })

  router.post('/', requirePermission(PERMISSIONS.SUPPLIER_MANAGE), async (req, res, next) => {
    try {
      const parsed = createSupplierSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid supplier data', parsed.error.issues)
      }
      const supplier = await service.create(parsed.data)
      res.status(201).json({ supplier })
    } catch (error) {
      next(error)
    }
  })

  router.put('/:id', requirePermission(PERMISSIONS.SUPPLIER_MANAGE), async (req, res, next) => {
    try {
      const parsed = updateSupplierSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid supplier data', parsed.error.issues)
      }
      const supplier = await service.update(parseSupplierId(req.params['id']), parsed.data)
      res.json({ supplier })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/:id', requirePermission(PERMISSIONS.SUPPLIER_MANAGE), async (req, res, next) => {
    try {
      const supplier = await service.deactivate(parseSupplierId(req.params['id']))
      res.json({ supplier })
    } catch (error) {
      next(error)
    }
  })

  return router
}
