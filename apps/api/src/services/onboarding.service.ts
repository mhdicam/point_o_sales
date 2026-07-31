/**
 * Onboarding service — S2-08.
 *
 * Provisions a new tenant in one transaction: tenant row → BusinessProfile from
 * the chosen preset → preset roles cloned with `isSystem: true` → first outlet →
 * owner user + membership + tenant-wide Owner role assignment.
 *
 * Runs unscoped. This is the one legitimate cross-tenant write in the app: the
 * tenant being created does not exist yet, so there is no context to bind. The
 * RLS GUC is set inside the transaction once the tenant id is known, which is
 * what lets the tenant-scoped inserts that follow pass `WITH CHECK`.
 *
 * The owner is created with `status: INVITED` and no password. They set one via
 * the invite flow; nothing here mints a credential the operator never chose.
 */

import type { BrewsyncClient } from '@brewsync/db'
import { runUnscoped } from '@brewsync/db'
import {
  PRESET_ROLES,
  defaultFeaturesFor,
  type BusinessPreset,
  type FeatureFlags,
} from '@brewsync/shared'
import { conflict } from '../http-error.js'

export interface OnboardTenantInput {
  /** URL-safe identifier, unique platform-wide. */
  slug: string
  name: string
  preset: BusinessPreset
  timezone?: string
  currency?: string
  /** The first outlet. A tenant with no outlet cannot transact. */
  outlet: {
    code: string
    name: string
  }
  owner: {
    email: string
    fullName: string
  }
  /** Overrides applied on top of the preset defaults. */
  featureOverrides?: Partial<FeatureFlags>
}

export interface OnboardTenantResult {
  tenantId: string
  outletId: string
  ownerUserId: string
  ownerMembershipId: string
  preset: BusinessPreset
  features: FeatureFlags
  roleIds: Record<string, string>
}

export class OnboardingService {
  constructor(private readonly db: BrewsyncClient) {}

  async onboard(input: OnboardTenantInput): Promise<OnboardTenantResult> {
    const features: FeatureFlags = {
      ...defaultFeaturesFor(input.preset),
      ...input.featureOverrides,
    }

    return runUnscoped(async () => {
      // Fail before opening the transaction on the two collisions a caller can
      // reasonably hit, so the error is a 409 with a clear code rather than a
      // raw unique-constraint violation.
      const existingTenant = await this.db.tenant.findUnique({
        where: { slug: input.slug },
        select: { id: true },
      })
      if (existingTenant) {
        throw conflict('SLUG_TAKEN', `Tenant slug "${input.slug}" is already in use`)
      }

      const existingUser = await this.db.user.findUnique({
        where: { email: input.owner.email },
        select: { id: true },
      })
      if (existingUser) {
        throw conflict('EMAIL_TAKEN', `A user with email "${input.owner.email}" already exists`)
      }

      return this.db.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            slug: input.slug,
            name: input.name,
            ...(input.timezone ? { timezone: input.timezone } : {}),
            ...(input.currency ? { currency: input.currency } : {}),
          },
          select: { id: true },
        })

        // RLS is FORCEd on tenant-scoped tables, so every insert below needs the
        // GUC bound. `true` scopes it to this transaction (standard: the
        // extension re-dispatches on tx, so a transaction-local GUC is correct).
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, tenant.id)

        await tx.businessProfile.create({
          data: {
            tenantId: tenant.id,
            preset: input.preset,
            features,
          },
        })

        const outlet = await tx.outlet.create({
          data: {
            tenantId: tenant.id,
            code: input.outlet.code,
            name: input.outlet.name,
          },
          select: { id: true },
        })

        // Preset roles are cloned per tenant with isSystem = true (design §12.2).
        const roleIds: Record<string, string> = {}
        for (const preset of PRESET_ROLES) {
          const role = await tx.role.create({
            data: {
              tenantId: tenant.id,
              name: preset.name,
              isSystem: true,
              permissions: {
                create: preset.permissions.map((permissionKey) => ({ permissionKey })),
              },
            },
            select: { id: true },
          })
          roleIds[preset.name] = role.id
        }

        // INVITED + no passwordHash: the owner completes signup via the invite,
        // so no provisional credential exists to leak or forget to rotate.
        const owner = await tx.user.create({
          data: {
            email: input.owner.email,
            fullName: input.owner.fullName,
            status: 'INVITED',
          },
          select: { id: true },
        })

        const membership = await tx.tenantMembership.create({
          data: {
            tenantId: tenant.id,
            userId: owner.id,
            displayName: input.owner.fullName,
            employeeCode: 'EMP-001',
          },
          select: { id: true },
        })

        // Owner is tenant-wide: outletId null grants across every outlet,
        // including ones created later.
        const ownerRoleId = roleIds['Owner']
        if (ownerRoleId) {
          await tx.userRole.create({
            data: {
              tenantId: tenant.id,
              userId: owner.id,
              roleId: ownerRoleId,
              outletId: null,
            },
          })
        }

        return {
          tenantId: tenant.id,
          outletId: outlet.id,
          ownerUserId: owner.id,
          ownerMembershipId: membership.id,
          preset: input.preset,
          features,
          roleIds,
        }
      })
    })
  }
}
