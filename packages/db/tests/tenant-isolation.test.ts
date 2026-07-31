/**
 * S1-07 — Tenant isolation test suite.
 *
 * Proves the two-layer standard:
 *   1. Prisma Client Extension injects tenantId filters/values.
 *   2. Postgres RLS denies cross-tenant access even when (1) is bypassed.
 *
 * Ground truth: fixtures are built by the owner role with the GUC set per
 * tenant, so writes satisfy `WITH CHECK` and the data is definitional rather
 * than machine-specific (no dependency on a local superuser).
 *
 * Layer two is only *visible* through a role RLS applies to. Postgres exempts
 * superusers and BYPASSRLS roles silently, so a harness pointed at the wrong
 * role would assert nothing while looking green. The "Harness preconditions"
 * block below pins that down and must stay first.
 *
 * Critical assertions:
 *   - Harness: the app role is non-superuser, NOBYPASSRLS, and owns no tables;
 *     the owner client really owns the tenant-scoped tables.
 *   - Layer one: the extension narrows queries to the context tenant; a
 *     caller-supplied tenantId cannot widen scope.
 *   - Layer two: RLS alone blocks cross-tenant reads; an unset GUC yields 0
 *     rows (fail closed); cross-tenant INSERT is refused by `WITH CHECK`.
 *   - Missing tenant context throws `MissingTenantContextError`.
 *   - Allowlist completeness: every table in RLS_TABLES has RLS enabled and
 *     forced with a `tenant_isolation` policy, and every model carrying
 *     `tenantId` appears in `TENANT_SCOPED_MODELS`.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') })
import { PrismaClient, type Prisma } from '../generated/client/index.js'
import {
  createPrismaClient,
  createUnscopedPrismaClient,
  clearTenantGuc,
  runWithTenantContext,
  MissingTenantContextError,
  TENANT_SCOPED_MODELS,
  RLS_TABLES,
  type BrewsyncClient,
} from '../src/index.js'

// Test database uses TEST_DATABASE_URL (app role) and TEST_DIRECT_DATABASE_URL (owner).
const APP_ROLE_URL = process.env.TEST_DATABASE_URL!
const OWNER_ROLE_URL = process.env.TEST_DIRECT_DATABASE_URL!

interface TenantFixture {
  tenantId: string
  slug: string
  outletId: string
  outletCode: string
}

let appClient: BrewsyncClient
let ownerClient: PrismaClient
let unscopedClient: PrismaClient
let fixtures: TenantFixture[]

beforeAll(async () => {
  appClient = createPrismaClient({ datasourceUrl: APP_ROLE_URL })
  ownerClient = new PrismaClient({ datasourceUrl: OWNER_ROLE_URL })
  unscopedClient = createUnscopedPrismaClient({ datasourceUrl: APP_ROLE_URL })

  // Build fixtures as the owner so writes pass `WITH CHECK`.
  fixtures = await buildFixtures(ownerClient)
})

afterAll(async () => {
  await cleanFixtures(ownerClient, fixtures)
  await appClient.$disconnect()
  await ownerClient.$disconnect()
  await unscopedClient.$disconnect()
})

describe('Tenant isolation — two layers', () => {
  /**
   * Layer two can only be *observed* through a role RLS actually applies to.
   * Postgres exempts superusers and BYPASSRLS roles silently, and exempts a
   * table's owner unless FORCE is set — so a harness pointed at the wrong role
   * reports a green layer two while enforcing nothing.
   *
   * That is not hypothetical: TEST_DATABASE_URL drifted to the `postgres`
   * superuser, and the layer-two tests below failed for reasons that looked like
   * an RLS bug. These assertions fail first, and say which knob is wrong.
   */
  describe('Harness preconditions: the app role must be constrainable', () => {
    it('connects as a non-superuser, NOBYPASSRLS role', async () => {
      const [row] = await unscopedClient.$queryRawUnsafe<
        Array<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>
      >(
        `SELECT rolname, rolsuper, rolbypassrls
         FROM pg_roles WHERE rolname = current_user`
      )

      expect(row, 'TEST_DATABASE_URL resolved no role').toBeDefined()
      expect(
        row?.rolsuper,
        `TEST_DATABASE_URL connects as superuser "${row?.rolname}" — RLS is exempt for superusers, so layer two proves nothing. Point it at the app role.`
      ).toBe(false)
      expect(
        row?.rolbypassrls,
        `Role "${row?.rolname}" has BYPASSRLS — RLS is exempt. Run: ALTER ROLE ${row?.rolname} NOBYPASSRLS;`
      ).toBe(false)
    })

    it('does not own the tenant-scoped tables', async () => {
      // An owner is exempt from its own policies unless FORCE is set. FORCE is
      // set (asserted below), so this is belt-and-braces — but an app role that
      // owns tables can also ALTER them, which defeats the safety net entirely.
      const owned = await unscopedClient.$queryRawUnsafe<Array<{ relname: string }>>(
        `SELECT c.relname
         FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace
           AND c.relkind = 'r'
           AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
         ORDER BY 1`
      )

      expect(
        owned.map((r) => r.relname),
        'The runtime role owns these tables; ownership implies ALTER, which can switch RLS off'
      ).toEqual([])
    })

    it('runs the owner client as the tables’ actual owner', async () => {
      // Fixtures are written through the owner client. If it is not the real
      // owner it may simply lack privileges (the S3 tables once landed under
      // `postgres`, leaving brewsync_owner with no grants at all).
      const [row] = await ownerClient.$queryRawUnsafe<
        Array<{ current_user: string; mismatched: bigint }>
      >(
        `SELECT current_user,
                count(*) FILTER (
                  WHERE pg_get_userbyid(c.relowner) <> current_user
                ) AS mismatched
         FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace
           AND c.relkind = 'r'
           AND c.relname = ANY($1::text[])`,
        [...RLS_TABLES]
      )

      expect(
        Number(row?.mismatched ?? -1),
        `TEST_DIRECT_DATABASE_URL connects as "${row?.current_user}", which does not own every tenant-scoped table. Fix with: REASSIGN OWNED BY <wrong-owner> TO ${row?.current_user};`
      ).toBe(0)
    })
  })

  describe('Layer one: Prisma Client Extension', () => {
    it('injects tenantId filter on reads', async () => {
      const [tenantA, tenantB] = fixtures as [TenantFixture, TenantFixture]

      const outletsA = await runWithTenantContext(
        { tenantId: tenantA.tenantId },
        async () => await appClient.outlet.findMany()
      )
      expect(outletsA).toHaveLength(1)
      expect(outletsA[0]?.code).toBe(tenantA.outletCode)

      const outletsB = await runWithTenantContext(
        { tenantId: tenantB.tenantId },
        async () => await appClient.outlet.findMany()
      )
      expect(outletsB).toHaveLength(1)
      expect(outletsB[0]?.code).toBe(tenantB.outletCode)
    })

    it('injects tenantId on create', async () => {
      const tenant = fixtures[0]!

      const created = await runWithTenantContext(
        { tenantId: tenant.tenantId },
        async () =>
          // The cast is the point of the test: `tenantId` is required by the
          // generated type but deliberately omitted here, because layer one is
          // what supplies it. If the extension stops injecting, this write fails
          // the NOT NULL constraint.
          await appClient.outlet.create({
            data: {
              code: 'AUTO',
              name: 'Auto-injected Tenant',
            } as unknown as Prisma.OutletCreateInput,
          })
      )

      expect(created.tenantId).toBe(tenant.tenantId)

      // Clean up.
      await ownerClient.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant', $1, false)`,
        tenant.tenantId
      )
      await ownerClient.outlet.delete({ where: { id: created.id } })
    })

    it('overwrites caller-supplied tenantId (cannot widen scope)', async () => {
      const [tenantA, tenantB] = fixtures as [TenantFixture, TenantFixture]

      const result = await runWithTenantContext(
        { tenantId: tenantA.tenantId },
        async () =>
          await appClient.outlet.findMany({
            // Hand-written tenantId — ESLint rejects this in services
            // (standard #1); tests are exempt precisely so this attack can be
            // simulated. The extension must overwrite it, not honour it.
            where: { tenantId: tenantB.tenantId },
          })
      )

      // The extension overwrites the caller's tenantId with the context's,
      // so this reads tenantA's row, not tenantB's.
      expect(result).toHaveLength(1)
      expect(result[0]?.tenantId).toBe(tenantA.tenantId)
    })

    it('throws MissingTenantContextError when context is not bound', async () => {
      // No runWithTenantContext wrapper.
      await expect(appClient.outlet.findMany()).rejects.toThrow(
        MissingTenantContextError
      )
    })
  })

  describe('Layer two: Postgres Row-Level Security', () => {
    it('denies cross-tenant reads even with the extension bypassed', async () => {
      const [tenantA, tenantB] = fixtures as [TenantFixture, TenantFixture]

      // Bind tenant A's GUC and query with the raw, unscoped client.
      await unscopedClient.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant', $1, false)`,
        tenantA.tenantId
      )
      const outletsA = await unscopedClient.outlet.findMany()
      expect(outletsA).toHaveLength(1)
      expect(outletsA[0]?.tenantId).toBe(tenantA.tenantId)

      // Rebind to tenant B and confirm the data set changes.
      await unscopedClient.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant', $1, false)`,
        tenantB.tenantId
      )
      const outletsB = await unscopedClient.outlet.findMany()
      expect(outletsB).toHaveLength(1)
      expect(outletsB[0]?.tenantId).toBe(tenantB.tenantId)
    })

    it('returns zero rows when the GUC is unset (fail closed)', async () => {
      await clearTenantGuc(unscopedClient)

      const outlets = await unscopedClient.outlet.findMany()

      // FORCE RLS + NULLIF(current_setting(...), '')::uuid ensures an unset
      // GUC yields NULL in the comparison → no rows, never all rows.
      expect(outlets).toHaveLength(0)
    })

    it('refuses cross-tenant INSERT via WITH CHECK', async () => {
      const [tenantA] = fixtures as [TenantFixture, TenantFixture]

      // Bind tenant A's GUC but attempt to insert tenant B's id.
      await unscopedClient.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant', $1, false)`,
        tenantA.tenantId
      )

      await expect(
        unscopedClient.outlet.create({
          data: {
            tenantId: fixtures[1]!.tenantId,
            code: 'POISON',
            name: 'Cross-Tenant Poison',
          },
        })
      ).rejects.toThrow(/new row violates row-level security policy/)
    })
  })

  describe('Allowlist completeness', () => {
    it('every table in RLS_TABLES has RLS enabled and forced', async () => {
      const missing: string[] = []

      for (const table of RLS_TABLES) {
        const [row] = await ownerClient.$queryRawUnsafe<
          Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
        >(
          `SELECT relrowsecurity, relforcerowsecurity
           FROM pg_class
           WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
          table
        )

        if (!row?.relrowsecurity || !row?.relforcerowsecurity) {
          missing.push(table)
        }
      }

      expect(missing).toEqual([])
    })

    it('every table in RLS_TABLES has a tenant_isolation policy', async () => {
      const missing: string[] = []

      for (const table of RLS_TABLES) {
        const [row] = await ownerClient.$queryRawUnsafe<
          Array<{ polname: string }>
        >(
          `SELECT polname FROM pg_policy
           WHERE polrelid = $1::regclass AND polname = 'tenant_isolation'`,
          `public.${table}`
        )

        if (!row) {
          missing.push(table)
        }
      }

      expect(missing).toEqual([])
    })

    it('every Prisma model with a tenantId field is in TENANT_SCOPED_MODELS', async () => {
      // Parsed from schema.prisma, not restated: the point of this test is to
      // catch a model added later that nobody remembered to add to the
      // allowlist. A hardcoded expected set would compare the answer to itself
      // and pass forever.
      const models = await parseModelsWithTenantId()

      // Sanity check the parser itself — if it silently matched nothing, the
      // assertion below would be vacuously true.
      expect(models.length).toBeGreaterThan(0)

      const unscoped = models.filter((model) => !TENANT_SCOPED_MODELS.has(model))
      expect(unscoped).toEqual([])
    })

    it('every table in RLS_TABLES maps to a model in TENANT_SCOPED_MODELS', async () => {
      // The two allowlists have to agree: a model scoped by layer one but with
      // no RLS table (or vice versa) means one layer is missing for it.
      const tables = await parseTableMapForModels([...TENANT_SCOPED_MODELS])

      expect([...tables].sort()).toEqual([...RLS_TABLES].sort())
    })
  })
})

const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/schema.prisma'
)

/** `model Foo { … }` blocks, keyed by model name. */
async function parseModelBlocks(): Promise<Map<string, string>> {
  const source = await readFile(SCHEMA_PATH, 'utf8')
  const blocks = new Map<string, string>()

  const pattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm
  let match: RegExpExecArray | null

  while ((match = pattern.exec(source)) !== null) {
    blocks.set(match[1]!, match[2]!)
  }

  return blocks
}

/** Model names declaring a scalar `tenantId` field. */
async function parseModelsWithTenantId(): Promise<string[]> {
  const blocks = await parseModelBlocks()
  const models: string[] = []

  for (const [name, body] of blocks) {
    // A scalar field declaration, not a mention inside a @relation(fields: […]).
    if (/^\s*tenantId\s+String/m.test(body)) {
      models.push(name)
    }
  }

  return models
}

/** `@@map` table names for the given models. */
async function parseTableMapForModels(models: string[]): Promise<string[]> {
  const blocks = await parseModelBlocks()
  const tables: string[] = []

  for (const model of models) {
    const body = blocks.get(model)
    if (!body) {
      throw new Error(`Model ${model} is in TENANT_SCOPED_MODELS but not in schema.prisma`)
    }
    const mapped = /@@map\("([^"]+)"\)/.exec(body)
    if (!mapped) {
      throw new Error(`Model ${model} has no @@map — RLS_TABLES cannot be checked against it`)
    }
    tables.push(mapped[1]!)
  }

  return tables
}

/** Build two tenant fixtures: one outlet each. */
async function buildFixtures(client: PrismaClient): Promise<TenantFixture[]> {
  const slugs = ['test-iso-alpha', 'test-iso-beta']
  const result: TenantFixture[] = []

  for (const slug of slugs) {
    // Create the tenant as owner; tenants have no tenantId themselves.
    const tenant = await client.tenant.upsert({
      where: { slug },
      update: {},
      create: { slug, name: `Isolation Test ${slug}` },
    })

    // Bind the GUC so the outlet write satisfies `WITH CHECK`.
    await client.$executeRawUnsafe(
      `SELECT set_config('app.current_tenant', $1, false)`,
      tenant.id
    )

    const outlet = await client.outlet.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: slug } },
      update: {},
      create: {
        tenantId: tenant.id,
        code: slug,
        name: `Outlet ${slug}`,
      },
    })

    result.push({
      tenantId: tenant.id,
      slug,
      outletId: outlet.id,
      outletCode: outlet.code,
    })
  }

  return result
}

async function cleanFixtures(
  client: PrismaClient,
  fixtures: TenantFixture[]
): Promise<void> {
  for (const f of fixtures) {
    await client.$executeRawUnsafe(
      `SELECT set_config('app.current_tenant', $1, false)`,
      f.tenantId
    )
    await client.outlet.deleteMany({ where: { tenantId: f.tenantId } })
    await client.tenant.delete({ where: { id: f.tenantId } })
  }
}
