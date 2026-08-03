/**
 * S3 DoD — nested categories: cycle rejection and default inheritance.
 *
 * The sprint plan names these two explicitly, and they are the parts of the
 * category tree that fail *quietly* if they regress.
 *
 * A cycle is not a validation nicety. Postgres is perfectly happy to store
 * `a.parent = b, b.parent = a`; nothing in the schema forbids it. The damage
 * shows up later, in whatever walks the tree — `resolveDefaults` here, the
 * category picker in S3-07, any report that rolls up by parent. A ring is also
 * invisible from the root, so the rows simply vanish from the UI while still
 * occupying their slugs. Hence: the guard lives in CategoryService, and this
 * file is the only thing holding it.
 *
 * Inheritance is tested through the service rather than by reading columns
 * because the precedence rule — nearest ancestor that sets the field wins, each
 * field independently — is the whole behaviour. The columns themselves are
 * nullable and say nothing about precedence.
 *
 * Everything runs under a real tenant context against the app role, so a
 * regression in tenant scoping fails here too rather than being masked.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPrismaClient, runUnscoped, runWithTenantContext } from '@brewsync/db'
import { CategoryService } from '../src/services/category.service.js'

loadEnv({ path: resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

const APP_ROLE_URL = process.env.TEST_DATABASE_URL!
const OWNER_ROLE_URL = withConnectionLimitOne(process.env.TEST_DIRECT_DATABASE_URL!)

/**
 * Pin the owner client to one connection so a session-level GUC persists across
 * the raw fixture inserts (outlet + stations are FORCE-RLS tables).
 */
function withConnectionLimitOne(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`
}

describe('S3 — category tree', () => {
  const dbApp = createPrismaClient({ datasourceUrl: APP_ROLE_URL })
  const dbOwner = createPrismaClient({ datasourceUrl: OWNER_ROLE_URL })
  const categories = new CategoryService(dbApp)

  const runId = randomUUID().slice(0, 8)
  let tenantId: string
  // A real outlet + two real stations back the `defaultStationId` FK the
  // "resolves each field independently" case sets on a category.
  let stationA: string
  let stationB: string
  let seq = 0

  /**
   * The `await` inside is load-bearing: a Prisma delegate returns a lazy promise
   * that dispatches on `.then()`, so returning it unawaited lets the
   * async-local frame exit first and the extension sees no tenant at all.
   */
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenantContext({ tenantId }, async () => await fn())

  /** Slugs are unique per tenant, so every fixture gets its own counter suffix. */
  async function makeCategory(
    name: string,
    extra: {
      parentId?: string | null
      defaultTaxRateBp?: number | null
      defaultStationId?: string | null
      reportGroup?: string | null
    } = {}
  ) {
    const n = ++seq
    return await asTenant(() =>
      categories.create({ name, slug: `${name.toLowerCase()}-${runId}-${n}`, ...extra })
    )
  }

  /** parent → child → grandchild, returned root-first. */
  async function makeChain(depth: number) {
    const chain: Array<{ id: string }> = []
    let parentId: string | null = null
    for (let level = 0; level < depth; level += 1) {
      const node = await makeCategory(`L${level}`, { parentId })
      chain.push(node)
      parentId = node.id
    }
    return chain
  }

  beforeAll(async () => {
    const rows = await runUnscoped(
      () => dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
        VALUES (gen_random_uuid(), ${`cat-${runId}`}, 'Category Test', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
        RETURNING id
      `
    )
    tenantId = rows[0]!.id

    // RLS is FORCEd, so even the owner is subject to it. The owner client is
    // pinned to one connection, so this session-level GUC stays bound across the
    // tenant-scoped inserts below (outlet + stations).
    await dbOwner.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, false)`, tenantId)

    const [outlet] = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO outlets (id, "tenantId", code, name, status, "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'MAIN', 'Main', 'ACTIVE', now())
      RETURNING id
    `
    const outletId = outlet!.id

    // `Category.defaultStationId` is an FK to `stations` (onDelete: SetNull), so
    // the inheritance case needs real stations rather than bare random UUIDs.
    const stations = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO stations (id, "tenantId", "outletId", name, "updatedAt")
      VALUES
        (gen_random_uuid(), ${tenantId}::uuid, ${outletId}::uuid, ${`Station A ${runId}`}, now()),
        (gen_random_uuid(), ${tenantId}::uuid, ${outletId}::uuid, ${`Station B ${runId}`}, now())
      RETURNING id
    `
    stationA = stations[0]!.id
    stationB = stations[1]!.id
  })

  afterAll(async () => {
    await runUnscoped(() => dbOwner.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`)
    await dbApp.$disconnect()
    await dbOwner.$disconnect()
  })

  describe('cycle rejection', () => {
    it('rejects a category becoming its own parent', async () => {
      const category = await makeCategory('Self')

      await expect(
        asTenant(() => categories.update(category.id, { parentId: category.id }))
      ).rejects.toThrow(/CATEGORY_CYCLE|its own parent/i)
    })

    it('rejects moving a parent under its own child', async () => {
      const [parent, child] = await makeChain(2)

      await expect(
        asTenant(() => categories.update(parent!.id, { parentId: child!.id }))
      ).rejects.toThrow(/CATEGORY_CYCLE|own descendants/i)
    })

    it('rejects moving a grandparent under its own grandchild', async () => {
      // The two-level case is what a naive `parentId === categoryId` check misses:
      // the guard has to walk the whole chain up from the proposed parent.
      const [root, , grandchild] = await makeChain(3)

      await expect(
        asTenant(() => categories.update(root!.id, { parentId: grandchild!.id }))
      ).rejects.toThrow(/CATEGORY_CYCLE|own descendants/i)
    })

    it('leaves the tree untouched when a move is rejected', async () => {
      const [parent, child] = await makeChain(2)

      await expect(
        asTenant(() => categories.update(parent!.id, { parentId: child!.id }))
      ).rejects.toThrow()

      // The check runs before the write, so a rejected move must not have
      // half-applied.
      const after = await asTenant(() => categories.getById(parent!.id))
      expect(after.parentId).toBeNull()
      expect(after.children.map((c) => c.id)).toEqual([child!.id])
    })

    it('allows a sideways move between branches', async () => {
      const [branchA, leaf] = await makeChain(2)
      const branchB = await makeCategory('BranchB')

      const moved = await asTenant(() => categories.update(leaf!.id, { parentId: branchB.id }))

      expect(moved.parentId).toBe(branchB.id)
      expect(branchA!.id).not.toBe(branchB.id)
    })

    it('allows promoting a child to the root', async () => {
      // parentId: null is not a re-parent under anything, so it skips the walk.
      const [, child] = await makeChain(2)

      const promoted = await asTenant(() => categories.update(child!.id, { parentId: null }))

      expect(promoted.parentId).toBeNull()
    })

    it('allows deepening a chain — a descendant move is not a cycle', async () => {
      const [root] = await makeChain(1)
      const other = await makeCategory('Other')

      const moved = await asTenant(() => categories.update(other.id, { parentId: root!.id }))

      expect(moved.parentId).toBe(root!.id)
    })

    it('rejects an unknown parent on create', async () => {
      await expect(
        asTenant(() => categories.create({ name: 'Orphan', slug: `orphan-${runId}`, parentId: randomUUID() }))
      ).rejects.toThrow(/not found/i)
    })

    it('rejects an unknown parent on update', async () => {
      const category = await makeCategory('Movable')

      await expect(
        asTenant(() => categories.update(category.id, { parentId: randomUUID() }))
      ).rejects.toThrow(/not found/i)
    })
  })

  describe('default inheritance', () => {
    it('returns all nulls for a root that sets nothing', async () => {
      const root = await makeCategory('Bare')

      const resolved = await asTenant(() => categories.resolveDefaults(root.id))

      expect(resolved).toEqual({
        defaultTaxRateBp: null,
        defaultStationId: null,
        reportGroup: null,
        inheritedFrom: { defaultTaxRateBp: null, defaultStationId: null, reportGroup: null },
      })
    })

    it('a child inherits the tax rate its parent sets', async () => {
      const parent = await makeCategory('Minuman', { defaultTaxRateBp: 1000 })
      const child = await makeCategory('Kopi', { parentId: parent.id })

      const resolved = await asTenant(() => categories.resolveDefaults(child.id))

      expect(resolved.defaultTaxRateBp).toBe(1000)
      expect(resolved.inheritedFrom.defaultTaxRateBp).toBe(parent.id)
    })

    it("a category's own value wins over its parent's", async () => {
      const parent = await makeCategory('Makanan', { defaultTaxRateBp: 1000 })
      const child = await makeCategory('Paket', { parentId: parent.id, defaultTaxRateBp: 1100 })

      const resolved = await asTenant(() => categories.resolveDefaults(child.id))

      expect(resolved.defaultTaxRateBp).toBe(1100)
      expect(resolved.inheritedFrom.defaultTaxRateBp).toBe(child.id)
    })

    it('the nearest ancestor that sets a field wins, not the furthest', async () => {
      const root = await makeCategory('Root', { defaultTaxRateBp: 1000 })
      const mid = await makeCategory('Mid', { parentId: root.id, defaultTaxRateBp: 500 })
      const leaf = await makeCategory('Leaf', { parentId: mid.id })

      const resolved = await asTenant(() => categories.resolveDefaults(leaf.id))

      expect(resolved.defaultTaxRateBp).toBe(500)
      expect(resolved.inheritedFrom.defaultTaxRateBp).toBe(mid.id)
    })

    it('skips ancestors that leave the field null', async () => {
      const root = await makeCategory('Top', { defaultTaxRateBp: 1100 })
      const mid = await makeCategory('Middle', { parentId: root.id })
      const leaf = await makeCategory('Bottom', { parentId: mid.id })

      const resolved = await asTenant(() => categories.resolveDefaults(leaf.id))

      // Null means "inherit", not "override with nothing" — the walk continues
      // past `mid` to the grandparent.
      expect(resolved.defaultTaxRateBp).toBe(1100)
      expect(resolved.inheritedFrom.defaultTaxRateBp).toBe(root.id)
    })

    it('resolves each field independently', async () => {
      // The case the design doc calls out: a category may take its tax rate from
      // the grandparent while setting its own station. One "nearest ancestor
      // that sets anything" would get this wrong.
      const root = await makeCategory('Vertical', {
        defaultTaxRateBp: 1000,
        defaultStationId: stationA,
        reportGroup: 'beverage',
      })
      const mid = await makeCategory('Branch', { parentId: root.id, defaultStationId: stationB })
      const leaf = await makeCategory('Item', { parentId: mid.id, reportGroup: 'signature' })

      const resolved = await asTenant(() => categories.resolveDefaults(leaf.id))

      expect(resolved).toEqual({
        defaultTaxRateBp: 1000,
        defaultStationId: stationB,
        reportGroup: 'signature',
        inheritedFrom: {
          defaultTaxRateBp: root.id,
          defaultStationId: mid.id,
          reportGroup: leaf.id,
        },
      })
    })

    it('follows the chain after a re-parent', async () => {
      const branchA = await makeCategory('BranchTax', { defaultTaxRateBp: 1000 })
      const branchB = await makeCategory('BranchOther', { defaultTaxRateBp: 500 })
      const leaf = await makeCategory('Moving', { parentId: branchA.id })

      expect((await asTenant(() => categories.resolveDefaults(leaf.id))).defaultTaxRateBp).toBe(1000)

      await asTenant(() => categories.update(leaf.id, { parentId: branchB.id }))

      const resolved = await asTenant(() => categories.resolveDefaults(leaf.id))
      expect(resolved.defaultTaxRateBp).toBe(500)
      expect(resolved.inheritedFrom.defaultTaxRateBp).toBe(branchB.id)
    })

    it('treats a zero tax rate as a set value, not as unset', async () => {
      // 0 bp is a real configuration (a non-taxable category). Anything using a
      // falsy check instead of a null check would inherit 1100 here.
      const parent = await makeCategory('Taxed', { defaultTaxRateBp: 1100 })
      const child = await makeCategory('Exempt', { parentId: parent.id, defaultTaxRateBp: 0 })

      const resolved = await asTenant(() => categories.resolveDefaults(child.id))

      expect(resolved.defaultTaxRateBp).toBe(0)
      expect(resolved.inheritedFrom.defaultTaxRateBp).toBe(child.id)
    })

    it('returns nulls for an unknown category rather than throwing', async () => {
      // resolveDefaults is a lookup used while rendering; a deleted category
      // should degrade to "no defaults", which is the same answer as a bare root.
      const resolved = await asTenant(() => categories.resolveDefaults(randomUUID()))

      expect(resolved.defaultTaxRateBp).toBeNull()
      expect(resolved.inheritedFrom.defaultTaxRateBp).toBeNull()
    })
  })
})
