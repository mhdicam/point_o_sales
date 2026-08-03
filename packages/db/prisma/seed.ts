/**
 * Seed — S0-03 skeleton, S2-01 (permission catalog), S2-02 (preset roles),
 * S2-08 (tenant provisioning), S3-06 (master product catalog per vertical), plus
 * one demo tenant per vertical so the "one core, many shapes" claim is visible in
 * the UI.
 *
 * Runs as the migration/owner role: seeding is deliberately cross-tenant, so it
 * uses the unscoped client and sets the RLS GUC per tenant as it goes.
 *
 * The per-vertical catalog data lives in ../src/seed-catalog.ts because this file
 * sits outside the package tsconfig `include` and is never typechecked.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { PrismaClient } from '../generated/client/index.js'
import { PRESET_ROLES, defaultFeaturesFor, type BusinessPreset } from '@brewsync/shared'
import { hash } from '@node-rs/argon2'
import { seedPermissionCatalog } from '../src/seed-permissions.js'
import { seedMasterCatalog } from '../src/seed-catalog.js'

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

    // S5-02 — default tenders (design §7.5). Data-driven: the flags drive
    // drawer/ref/cash-reconciliation behaviour, so a new method is a new row.
    const paymentMethods: {
      code: string
      name: string
      kind: 'CASH' | 'CARD' | 'QRIS' | 'EWALLET' | 'VOUCHER' | 'POINTS' | 'OTHER'
      opensCashDrawer: boolean
      needsRefNo: boolean
      countsAsCash: boolean
      sortOrder: number
    }[] = [
      { code: 'CASH', name: 'Tunai', kind: 'CASH', opensCashDrawer: true, needsRefNo: false, countsAsCash: true, sortOrder: 1 },
      { code: 'CARD', name: 'Kartu Debit/Kredit', kind: 'CARD', opensCashDrawer: false, needsRefNo: true, countsAsCash: false, sortOrder: 2 },
      { code: 'QRIS', name: 'QRIS', kind: 'QRIS', opensCashDrawer: false, needsRefNo: true, countsAsCash: false, sortOrder: 3 },
    ]
    for (const pm of paymentMethods) {
      await prisma.paymentMethod.upsert({
        where: { tenantId_code: { tenantId: tenant.id, code: pm.code } },
        update: {},
        create: { tenantId: tenant.id, ...pm },
      })
    }

    // S7-01 — sales methods (design §6). Fiscal columns left null (no-op in S7);
    // tax/SC still come from the outlet. The set differs per preset: F&B serves
    // in-house and to-go and delivers; retail is takeaway-only at the counter;
    // service is an in-store appointment.
    const salesMethods: {
      code: string
      name: string
      kind: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'
      sortOrder: number
    }[] =
      spec.preset === 'FNB'
        ? [
            { code: 'DINE_IN', name: 'Makan di Tempat', kind: 'DINE_IN', sortOrder: 1 },
            { code: 'TAKEAWAY', name: 'Bawa Pulang', kind: 'TAKEAWAY', sortOrder: 2 },
            { code: 'DELIVERY', name: 'Pesan Antar', kind: 'DELIVERY', sortOrder: 3 },
          ]
        : spec.preset === 'RETAIL'
          ? [{ code: 'TAKEAWAY', name: 'Ambil di Toko', kind: 'TAKEAWAY', sortOrder: 1 }]
          : [{ code: 'DINE_IN', name: 'Di Tempat', kind: 'DINE_IN', sortOrder: 1 }]
    for (const sm of salesMethods) {
      await prisma.salesMethod.upsert({
        where: { tenantId_code: { tenantId: tenant.id, code: sm.code } },
        update: {},
        create: { tenantId: tenant.id, ...sm },
      })
    }

    // S7-02 — floor plan (design §5.4). Only FNB (and MIXED later) have
    // `features.tables` on; retail/service skip this. Seed one floor per outlet
    // with a few demo tables so the cashier order screen can seat orders.
    if (spec.preset === 'FNB') {
      for (const code of spec.outlets) {
        const outlet = await prisma.outlet.findUnique({
          where: { tenantId_code: { tenantId: tenant.id, code } },
        })
        if (!outlet) continue

        const floor = await prisma.area.upsert({
          where: { id: `${outlet.id}-main-floor` },
          update: {},
          create: {
            id: `${outlet.id}-main-floor`,
            tenantId: tenant.id,
            outletId: outlet.id,
            kind: 'FLOOR',
            name: 'Lantai Utama',
            sortOrder: 1,
          },
        })

        const indoorSection = await prisma.area.upsert({
          where: { id: `${outlet.id}-indoor` },
          update: {},
          create: {
            id: `${outlet.id}-indoor`,
            tenantId: tenant.id,
            outletId: outlet.id,
            parentId: floor.id,
            kind: 'AREA',
            name: 'Dalam Ruangan',
            sortOrder: 1,
          },
        })

        const outdoorSection = await prisma.area.upsert({
          where: { id: `${outlet.id}-outdoor` },
          update: {},
          create: {
            id: `${outlet.id}-outdoor`,
            tenantId: tenant.id,
            outletId: outlet.id,
            parentId: floor.id,
            kind: 'AREA',
            name: 'Teras',
            sortOrder: 2,
          },
        })

        // Demo tables: 3 inside, 2 outside. Each gets a unique qrToken for
        // self-service ordering (§16.2); the randomBytes call in table.service
        // generates it on create, so we use a fixed seed id here.
        const tables: Array<{ id: string; code: string; name: string; areaId: string; capacity: number; sortOrder: number }> = [
          { id: `${outlet.id}-t1`, code: 'T1', name: 'Meja 1', areaId: indoorSection.id, capacity: 2, sortOrder: 1 },
          { id: `${outlet.id}-t2`, code: 'T2', name: 'Meja 2', areaId: indoorSection.id, capacity: 4, sortOrder: 2 },
          { id: `${outlet.id}-t3`, code: 'T3', name: 'Meja 3', areaId: indoorSection.id, capacity: 4, sortOrder: 3 },
          { id: `${outlet.id}-t4`, code: 'T4', name: 'Meja 4', areaId: outdoorSection.id, capacity: 2, sortOrder: 4 },
          { id: `${outlet.id}-t5`, code: 'T5', name: 'Meja 5', areaId: outdoorSection.id, capacity: 6, sortOrder: 5 },
        ]

        for (const t of tables) {
          await prisma.table.upsert({
            where: { id: t.id },
            update: {},
            create: {
              id: t.id,
              tenantId: tenant.id,
              outletId: outlet.id,
              areaId: t.areaId,
              code: t.code,
              name: t.name,
              status: 'EMPTY',
              capacity: t.capacity,
              qrToken: `demo-qr-${t.code.toLowerCase()}-${code.toLowerCase()}`,
              sortOrder: t.sortOrder,
            },
          })
        }

        // S7-04 — KDS prep stations (design §5.5). Seeded per outlet with a
        // stable set of names ('Bar', 'Dapur'); category→station routing resolves
        // by NAME in the order's outlet at SENT, so the same category maps
        // correctly across every outlet without a per-outlet mapping table.
        const stations: Array<{ name: string; sortOrder: number }> = [
          { name: 'Bar', sortOrder: 1 },
          { name: 'Dapur', sortOrder: 2 },
        ]
        for (const s of stations) {
          await prisma.station.upsert({
            where: { id: `${outlet.id}-station-${s.name.toLowerCase()}` },
            update: {},
            create: {
              id: `${outlet.id}-station-${s.name.toLowerCase()}`,
              tenantId: tenant.id,
              outletId: outlet.id,
              name: s.name,
              sortOrder: s.sortOrder,
            },
          })
        }
      }
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

    // S3-06 — master product catalog. Runs last in the loop because price lists
    // reference outlets, and still inside it because the GUC bound above is what
    // lets these tenant-scoped rows through RLS.
    const catalog = await seedMasterCatalog(prisma, tenant.id, spec.slug)

    // S7-04 — category → station routing (design §5.5). Categories are
    // tenant-scoped, so `defaultStationId` just names the target station; the
    // concrete station is resolved per outlet by name at SENT. Point each FNB
    // category at the first outlet's station of the intended name — any outlet's
    // same-named station would do, since only the NAME is used downstream.
    if (spec.preset === 'FNB') {
      const firstCode = spec.outlets[0]
      const firstOutlet = firstCode
        ? await prisma.outlet.findUnique({
            where: { tenantId_code: { tenantId: tenant.id, code: firstCode } },
          })
        : null
      if (firstOutlet) {
        const stationByName = new Map(
          (
            await prisma.station.findMany({
              where: { outletId: firstOutlet.id },
              select: { id: true, name: true },
            })
          ).map((s) => [s.name, s.id])
        )
        // Drinks → Bar, food → Dapur. Packaged beans (STOCKED) never route.
        const categoryStation: Record<string, string> = {
          'minuman-kopi': 'Bar',
          'minuman-non-kopi': 'Bar',
          makanan: 'Dapur',
        }
        for (const [slug, stationName] of Object.entries(categoryStation)) {
          const stationId = stationByName.get(stationName)
          if (!stationId) continue
          await prisma.category.updateMany({
            where: { tenantId: tenant.id, slug },
            data: { defaultStationId: stationId },
          })
        }
      }
    }

    console.log(`  ${spec.outlets.length} outlet(s), ${PRESET_ROLES.length} roles, 2 users`)
    console.log(
      `  ${catalog.units} units, ${catalog.categories} categories, ` +
        `${catalog.products} products / ${catalog.variants} variants, ` +
        `${catalog.images} images, ${catalog.modifierGroups} modifier groups, ` +
        `${catalog.priceLists} price lists`
    )
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
