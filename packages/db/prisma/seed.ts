/**
 * Seed — S0-03 skeleton, S2-01 (permission catalog), S2-02 (preset roles),
 * S2-08 (tenant provisioning), plus one demo tenant per vertical so the
 * "one core, many shapes" claim is visible in the UI (S3-06 extends this).
 *
 * Runs as the migration/owner role: seeding is deliberately cross-tenant, so it
 * uses the unscoped client and sets the RLS GUC per tenant as it goes.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { PrismaClient } from '../generated/client/index.js'
import { PRESET_ROLES, defaultFeaturesFor, type BusinessPreset } from '@brewsync/shared'
import { hash } from '@node-rs/argon2'
import { seedPermissionCatalog } from '../src/seed-permissions.js'

// The seed runs from packages/db but .env lives at the workspace root.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

const prisma = new PrismaClient({
  datasourceUrl: process.env['DIRECT_DATABASE_URL'] ?? process.env['DATABASE_URL'],
})

const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

async function main() {
  console.log('› Seeding permission catalog…')
  const permissionCount = await seedPermissionCatalog(prisma)
  console.log(`  ${permissionCount} permissions`)

  const demoTenants: { slug: string; name: string; preset: BusinessPreset; outlets: string[] }[] = [
    { slug: 'kopi-nusantara', name: 'Kopi Nusantara', preset: 'FNB', outlets: ['PST', 'DPK'] },
    { slug: 'toko-serba-ada', name: 'Toko Serba Ada', preset: 'RETAIL', outlets: ['TSA'] },
    { slug: 'barbershop-rapi', name: 'Barbershop Rapi', preset: 'SERVICE', outlets: ['BR1'] },
  ]

  const passwordHash = await hash('password123', ARGON2_OPTIONS)
  const pinHash = await hash('1234', ARGON2_OPTIONS)

  for (const spec of demoTenants) {
    console.log(`› Provisioning ${spec.name} (${spec.preset})…`)

    const tenant = await prisma.tenant.upsert({
      where: { slug: spec.slug },
      update: {},
      create: { slug: spec.slug, name: spec.name },
    })

    // RLS is FORCEd, so even the owner role needs the GUC bound to write
    // tenant-scoped rows.
    await prisma.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, false)`, tenant.id)

    await prisma.businessProfile.upsert({
      where: { tenantId: tenant.id },
      update: {},
      create: {
        tenantId: tenant.id,
        preset: spec.preset,
        features: defaultFeaturesFor(spec.preset),
      },
    })

    for (const [index, code] of spec.outlets.entries()) {
      await prisma.outlet.upsert({
        where: { tenantId_code: { tenantId: tenant.id, code } },
        update: {},
        create: {
          tenantId: tenant.id,
          code,
          name: `${spec.name} ${code}`,
          // Retail typically prices tax-inclusive; F&B adds PB1 on top (design §6.3).
          taxInclusive: spec.preset === 'RETAIL',
          taxRateBp: spec.preset === 'FNB' ? 1000 : 1100,
          serviceChargeRateBp: spec.preset === 'FNB' ? 500 : 0,
          stockDeductionPoint: spec.preset === 'FNB' ? 'SENT' : 'PAID',
          cashVarianceToleranceMinor: 5000n,
          ...(index === 0 ? {} : {}),
        },
      })
    }

    // Preset roles are cloned per tenant with isSystem = true (design §12.2).
    const roleIds = new Map<string, string>()
    for (const preset of PRESET_ROLES) {
      const role = await prisma.role.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name: preset.name } },
        update: {},
        create: { tenantId: tenant.id, name: preset.name, isSystem: true },
      })
      roleIds.set(preset.name, role.id)

      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
      await prisma.rolePermission.createMany({
        data: preset.permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })),
        skipDuplicates: true,
      })
    }

    // Owner + one cashier per tenant.
    const ownerEmail = `owner@${spec.slug}.test`
    const owner = await prisma.user.upsert({
      where: { email: ownerEmail },
      update: {},
      create: {
        email: ownerEmail,
        fullName: `Owner ${spec.name}`,
        passwordHash,
        status: 'ACTIVE',
      },
    })

    const cashierEmail = `kasir@${spec.slug}.test`
    const cashier = await prisma.user.upsert({
      where: { email: cashierEmail },
      update: {},
      create: {
        email: cashierEmail,
        fullName: `Kasir ${spec.name}`,
        passwordHash,
        status: 'ACTIVE',
      },
    })

    await prisma.tenantMembership.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: owner.id } },
      update: {},
      create: {
        tenantId: tenant.id,
        userId: owner.id,
        displayName: 'Owner',
        employeeCode: 'EMP-001',
        pinHash,
      },
    })

    await prisma.tenantMembership.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: cashier.id } },
      update: {},
      create: {
        tenantId: tenant.id,
        userId: cashier.id,
        displayName: 'Kasir',
        employeeCode: 'EMP-002',
        pinHash,
      },
    })

    // Owner is tenant-wide (outletId null); the cashier is scoped to one outlet,
    // which is what makes the outlet-scoped resolver worth testing (design §12.2).
    const ownerRoleId = roleIds.get('Owner')
    if (ownerRoleId) {
      const existing = await prisma.userRole.findFirst({
        where: { tenantId: tenant.id, userId: owner.id, roleId: ownerRoleId, outletId: null },
      })
      if (!existing) {
        await prisma.userRole.create({
          data: { tenantId: tenant.id, userId: owner.id, roleId: ownerRoleId, outletId: null },
        })
      }
    }

    const firstOutletCode = spec.outlets[0]
    const cashierRoleId = roleIds.get('Kasir')
    if (cashierRoleId && firstOutletCode) {
      const outlet = await prisma.outlet.findUnique({
        where: { tenantId_code: { tenantId: tenant.id, code: firstOutletCode } },
      })
      if (outlet) {
        const existing = await prisma.userRole.findFirst({
          where: {
            tenantId: tenant.id,
            userId: cashier.id,
            roleId: cashierRoleId,
            outletId: outlet.id,
          },
        })
        if (!existing) {
          await prisma.userRole.create({
            data: {
              tenantId: tenant.id,
              userId: cashier.id,
              roleId: cashierRoleId,
              outletId: outlet.id,
            },
          })
        }
      }
    }

    console.log(`  ${spec.outlets.length} outlet(s), ${PRESET_ROLES.length} roles, 2 users`)
  }

  console.log('\n✔ Seed complete. Demo logins (password: password123, PIN: 1234):')
  for (const t of demoTenants) {
    console.log(`   owner@${t.slug}.test · kasir@${t.slug}.test  [${t.preset}]`)
  }
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
