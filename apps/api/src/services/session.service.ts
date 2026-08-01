/**
 * Tenant selection for an authenticated session — S2-09.
 *
 * An email/password login authenticates a *person*, and a person is global (see
 * GLOBAL_MODELS): the same login may hold memberships in several tenants. The
 * token minted at login therefore carries no tenant, and every tenant-scoped
 * route is closed to it until one is chosen here.
 *
 * The client sends a tenantId, but that is a *selector*, not a credential — the
 * same reasoning documented on the PIN route. What authorises the switch is the
 * membership row tying the token's `sub` to that tenant; a caller naming a
 * tenant they do not belong to matches nothing and gets the same 403 as one
 * naming a tenant that does not exist.
 */

import type { BrewsyncClient } from '@brewsync/db'
import { runUnscoped, runWithTenantContext } from '@brewsync/db'
import { forbidden } from '../http-error.js'

export interface MembershipSummary {
  tenantId: string
  tenantName: string
  tenantSlug: string
  displayName: string | null
  employeeCode: string | null
  outlets: { id: string; code: string; name: string }[]
}

export interface SelectedScope {
  tenantId: string
  outletId: string | undefined
}

export class SessionService {
  constructor(private readonly db: BrewsyncClient) {}

  /**
   * Tenants this user can act in, with the outlets of each.
   *
   * Runs unscoped by necessity: the whole point is to read *across* tenants, and
   * the caller has no tenant context yet. The `userId` filter is what bounds the
   * result — it comes from the verified token, never from the request body.
   */
  async listMemberships(userId: string): Promise<MembershipSummary[]> {
    const memberships = await runUnscoped(() =>
      this.db.tenantMembership.findMany({
        where: { userId, status: 'ACTIVE' },
        include: { tenant: { select: { id: true, name: true, slug: true } } },
        orderBy: { joinedAt: 'asc' },
      })
    )

    if (memberships.length === 0) return []

    // Outlets are tenant-scoped, so each tenant's list is read inside its own
    // context rather than in one unscoped query — the extension and RLS then
    // both apply, and this stays honest about which tenant each row came from.
    return Promise.all(
      memberships.map(async (membership) => {
        // The `await` inside is load-bearing: a Prisma delegate returns a lazy
        // promise that dispatches on `.then()`, so returning it unawaited lets
        // the async-local frame exit before the extension reads the context.
        const outlets = await runWithTenantContext(
          { tenantId: membership.tenantId },
          async () =>
            await this.db.outlet.findMany({
              where: { status: 'ACTIVE' },
              select: { id: true, code: true, name: true },
              orderBy: { code: 'asc' },
            })
        )

        return {
          tenantId: membership.tenantId,
          tenantName: membership.tenant.name,
          tenantSlug: membership.tenant.slug,
          displayName: membership.displayName,
          employeeCode: membership.employeeCode,
          outlets,
        }
      })
    )
  }

  /**
   * Verify the user may act in `tenantId` (and `outletId`, when given).
   *
   * Returns the scope to mint a token with. Throws rather than returning null so
   * a caller cannot forget to check.
   */
  async selectScope(
    userId: string,
    tenantId: string,
    outletId?: string | undefined
  ): Promise<SelectedScope> {
    const membership = await runUnscoped(() =>
      this.db.tenantMembership.findFirst({
        where: { userId, tenantId, status: 'ACTIVE' },
        select: { id: true },
      })
    )

    // Same message for "not a member" and "no such tenant": telling the two
    // apart would turn this into a tenant-enumeration oracle.
    if (!membership) {
      throw forbidden('TENANT_NOT_ACCESSIBLE', 'No active membership for the requested tenant')
    }

    if (outletId) {
      // Scoped lookup: an outlet id belonging to another tenant is invisible
      // here, so cross-tenant outlet ids fail as "not found" without a manual
      // tenant filter (standard #1).
      // Same load-bearing `await` as above.
      const outlet = await runWithTenantContext(
        { tenantId },
        async () => await this.db.outlet.findFirst({ where: { id: outletId }, select: { id: true } })
      )

      if (!outlet) {
        throw forbidden('OUTLET_NOT_ACCESSIBLE', 'Outlet does not belong to the selected tenant')
      }
    }

    return { tenantId, outletId }
  }
}
