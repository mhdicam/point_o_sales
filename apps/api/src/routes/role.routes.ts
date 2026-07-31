/**
 * Role routes — S2-02 custom role CRUD.
 *
 * System roles (`isSystem: true`) are provisioned during onboarding and cannot
 * be edited or deleted — updates return 403, deletes 404.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import { getTenantContext } from '@brewsync/db'
import { RoleService } from '../services/role.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { PERMISSIONS, ALL_PERMISSIONS, type PermissionKey } from '@brewsync/shared'
import { badRequest } from '../http-error.js'

// Validating against the real catalog rather than plain strings: an unknown key
// is a 400 at the boundary instead of a foreign-key violation surfacing as a
// 500 from the nested RolePermission create.
const permissionKeySchema = z.enum(ALL_PERMISSIONS as [PermissionKey, ...PermissionKey[]])

const createRoleSchema = z.object({
  name: z.string().min(1).max(100),
  permissions: z.array(permissionKeySchema),
})

const updateRoleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  permissions: z.array(permissionKeySchema).optional(),
})

const roleIdSchema = z.string().uuid()

/** A non-uuid `:id` is a client error, not a 500 from Postgres rejecting the cast. */
function parseRoleId(raw: unknown): string {
  const parsed = roleIdSchema.safeParse(raw)
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', 'Role id must be a uuid')
  }
  return parsed.data
}

export function createRoleRouter(db: BrewsyncClient): Router {
  const router = Router()
  const roleService = new RoleService(db)
  const requirePermission = createPermissionMiddleware(db)

  router.get('/', requirePermission(PERMISSIONS.ROLE_MANAGE), async (_req, res, next) => {
    try {
      const roles = await roleService.list()
      res.json({ roles })
    } catch (error) {
      next(error)
    }
  })

  router.get('/:id', requirePermission(PERMISSIONS.ROLE_MANAGE), async (req, res, next) => {
    try {
      const role = await roleService.getById(parseRoleId(req.params['id']))
      res.json({ role })
    } catch (error) {
      next(error)
    }
  })

  router.post('/', requirePermission(PERMISSIONS.ROLE_MANAGE), async (req, res, next) => {
    try {
      const parsed = createRoleSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid role data', parsed.error.issues)
      }

      const context = getTenantContext()
      if (!context?.userId) {
        throw badRequest('MISSING_USER', 'Token carries no subject')
      }

      const role = await roleService.create(parsed.data, context.userId)
      res.status(201).json({ role })
    } catch (error) {
      next(error)
    }
  })

  router.put('/:id', requirePermission(PERMISSIONS.ROLE_MANAGE), async (req, res, next) => {
    try {
      const parsed = updateRoleSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid role data', parsed.error.issues)
      }

      const role = await roleService.update(parseRoleId(req.params['id']), parsed.data)
      res.json({ role })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/:id', requirePermission(PERMISSIONS.ROLE_MANAGE), async (req, res, next) => {
    try {
      const deleted = await roleService.delete(parseRoleId(req.params['id']))
      res.json({ deleted })
    } catch (error) {
      next(error)
    }
  })

  return router
}
