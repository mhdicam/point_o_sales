/**
 * Role service — S2-02 custom role CRUD.
 *
 * Roles are tenant-scoped. System roles (`isSystem: true`) are provisioned
 * during onboarding and cannot be edited or deleted via this service — updates
 * reject with 403, and deletes fail silently (design §12.3: preset roles are
 * immutable snapshots; tenants clone + edit them if customization is needed).
 */

import type { BrewsyncClient, Prisma } from '@brewsync/db'
import { getTenantContext } from '@brewsync/db'
import { forbidden, notFound } from '../http-error.js'
import type { PermissionKey } from '@brewsync/shared'

interface CreateRoleInput {
  name: string
  permissions: PermissionKey[]
}

interface UpdateRoleInput {
  name?: string
  permissions?: PermissionKey[]
}

export class RoleService {
  constructor(private readonly db: BrewsyncClient) {}

  async create(input: CreateRoleInput, createdBy: string) {
    const context = getTenantContext()
    if (!context?.tenantId) {
      throw forbidden('TENANT_REQUIRED', 'Role creation requires a tenant context')
    }

    const role = await this.db.role.create({
      // `tenantId` is deliberately absent: the Prisma extension injects it
      // (standard #1). The generated type demands it, so the cast is the seam
      // between "what the schema requires" and "what the extension supplies".
      data: {
        name: input.name,
        isSystem: false,
        createdBy,
        permissions: {
          create: input.permissions.map((key) => ({ permissionKey: key })),
        },
      } as unknown as Prisma.RoleCreateInput,
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    })

    return role
  }

  async update(roleId: string, input: UpdateRoleInput) {
    const role = await this.db.role.findUnique({ where: { id: roleId } })

    if (!role) {
      throw notFound('ROLE_NOT_FOUND', 'Role not found')
    }

    if (role.isSystem) {
      throw forbidden(
        'SYSTEM_ROLE_IMMUTABLE',
        'System roles cannot be modified. Clone and customize instead.'
      )
    }

    const updated = await this.db.role.update({
      where: { id: roleId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.permissions !== undefined && {
          permissions: {
            deleteMany: {},
            create: input.permissions.map((key) => ({ permissionKey: key })),
          },
        }),
      },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    })

    return updated
  }

  async delete(roleId: string): Promise<boolean> {
    const role = await this.db.role.findUnique({ where: { id: roleId } })

    if (!role) {
      return false
    }

    // System roles are immutable — silently refuse rather than throwing, so a
    // bulk-delete loop doesn't abort on encountering one.
    if (role.isSystem) {
      return false
    }

    await this.db.role.delete({ where: { id: roleId } })
    return true
  }

  async list() {
    const roles = await this.db.role.findMany({
      include: {
        permissions: {
          include: { permission: true },
        },
        _count: {
          select: { userRoles: true },
        },
      },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    })

    return roles
  }

  async getById(roleId: string) {
    const role = await this.db.role.findUnique({
      where: { id: roleId },
      include: {
        permissions: {
          include: { permission: true },
        },
        _count: {
          select: { userRoles: true },
        },
      },
    })

    if (!role) {
      throw notFound('ROLE_NOT_FOUND', 'Role not found')
    }

    return role
  }
}
