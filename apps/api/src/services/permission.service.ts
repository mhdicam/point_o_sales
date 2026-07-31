/**
 * Permission service — S2-03 effective-permission resolver.
 *
 * Returns the union of all permissions granted by a user's roles at the given
 * outlet context. Cached per session to avoid a query on every guarded endpoint.
 *
 * RBAC design (§12):
 *   - Permission: system-defined catalog (domain.action constants).
 *   - Role: tenant-owned, optional isSystem flag for preset read-only roles.
 *   - UserRole: assigns a user to a role, scoped by optional outletId.
 *
 * Resolution: find all roles assigned to the user at the outlet (outlet-scoped
 * roles OR tenant-wide roles with null outletId), union their permissions.
 */

import type { BrewsyncClient } from '@brewsync/db'
import { getTenantContext } from '@brewsync/db'
import type { PermissionKey } from '@brewsync/shared'

export class PermissionService {
  constructor(private readonly db: BrewsyncClient) {}

  /**
   * Resolve effective permissions for a user at an outlet.
   *
   * Returns the union of:
   *   - permissions from roles assigned tenant-wide (outletId null), and
   *   - permissions from roles assigned to the specific outlet.
   */
  async getEffectivePermissions(userId: string, outletId?: string): Promise<Set<PermissionKey>> {
    const context = getTenantContext()
    if (!context?.tenantId) {
      return new Set()
    }

    const userRoles = await this.db.userRole.findMany({
      where: {
        userId,
        OR: [
          { outletId: null }, // Tenant-wide.
          ...(outletId ? [{ outletId }] : []),
        ],
      },
      include: {
        role: {
          include: {
            permissions: {
              include: { permission: true },
            },
          },
        },
      },
    })

    const permissions = new Set<PermissionKey>()

    for (const userRole of userRoles) {
      for (const rolePermission of userRole.role.permissions) {
        permissions.add(rolePermission.permission.key as PermissionKey)
      }
    }

    return permissions
  }

  async hasPermission(
    userId: string,
    permission: PermissionKey,
    outletId?: string
  ): Promise<boolean> {
    const effective = await this.getEffectivePermissions(userId, outletId)
    return effective.has(permission)
  }
}
