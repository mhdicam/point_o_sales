/**
 * S3-05 — price resolver matrix. Design §3.3.
 *
 * Price is not one number on a variant: a `PriceList` scoped to an outlet and/or
 * a sales method overrides `ProductVariant.basePrice`. The resolution order is
 * the part that must not drift, and S4's bill pipeline calls `resolve()` for
 * every line, so an ordering bug here surfaces as a wrong total rather than as a
 * failing test. This suite pins the order down.
 *
 * Order under test: most specific matching active in-window list → ties broken by
 * `priority` desc → then `createdAt` desc → else `basePrice`.
 *
 * Specificity tiers, high to low: outlet+salesMethod, outlet-only,
 * salesMethod-only, global. NOTE: design §3.3 names `priority` as a tie-break but
 * is silent on specificity ordering; that specificity outranks `priority` is our
 * reading, and this file is what fixes it. `specificity()` in price.service.ts is
 * the single place to change if that reading is ever revised.
 *
 * Runs against the app role with tenant scoping live (not `runUnscoped`), so the
 * resolver's queries go through the extension and RLS the way a request does.
 * That is a realism guarantee, not an isolation proof: these fixtures hold one
 * tenant, so a missing extension filter would have nothing to leak into and
 * would not turn this suite red. Cross-tenant isolation is proven in
 * packages/db/tests/tenant-isolation.test.ts, which is also where the harness
 * asserts the app role is genuinely subject to RLS.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPrismaClient, runUnscoped, runWithTenantContext, Prisma } from '@brewsync/db'
import { PriceService, type ResolvedPrice } from '../src/services/price.service.js'

loadEnv({ path: resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

const APP_ROLE_URL = process.env.TEST_DATABASE_URL!

// Fixtures are written as the owner because RLS is FORCEd: inserts must satisfy
// `WITH CHECK`, which reads the `app.current_tenant` GUC. The GUC is set at
// session level once, so the owner client is pinned to a single connection —
// otherwise a later insert could land on a pooled connection that never saw it.
const OWNER_ROLE_URL = withConnectionLimitOne(process.env.TEST_DIRECT_DATABASE_URL!)

function withConnectionLimitOne(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`
}

const HOUR = 60 * 60 * 1000

describe('S3-05 — price resolver', () => {
  const dbApp = createPrismaClient({ datasourceUrl: APP_ROLE_URL })
  const dbOwner = createPrismaClient({ datasourceUrl: OWNER_ROLE_URL })
  const priceService = new PriceService(dbApp)

  const runId = randomUUID().slice(0, 8)
  let tenantId: string
  let outletId: string
  let otherOutletId: string
  let productId: string

  /** Resolves in the tenant's context, the way a real request would. */
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenantContext({ tenantId, outletId }, fn)

  /**
   * Each test gets its own variant. A list only competes for a variant it holds
   * an item for, so per-variant fixtures keep the cases independent instead of
   * making every assertion depend on which lists earlier tests happened to add.
   */
  let variantSeq = 0
  async function createVariant(basePrice: bigint): Promise<string> {
    const sku = `SKU-${runId}-${++variantSeq}`
    const rows = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO product_variants (id, "tenantId", "productId", sku, name, "basePrice", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${productId}::uuid, ${sku}, ${sku}, ${basePrice}, now())
      RETURNING id
    `
    return rows[0]!.id
  }

  /**
   * Raw SQL only. The `validFrom`/`validTo`/`createdAt` columns are
   * `timestamp(3)` — no zone — and this session's TimeZone is Asia/Jakarta, so a
   * bound `Date` arrives as `timestamptz`, is rendered to +07 wall clock, and
   * loses the offset on store: 12:00Z would land as 19:00. Prisma's typed reads
   * then interpret that back as 19:00Z, putting every fixture 7 hours ahead of
   * intent. `AT TIME ZONE 'UTC'` pins the wall clock to UTC so raw writes agree
   * with the typed reads the resolver does. Not needed for `now()` columns.
   */
  const utc = (d: Date) => Prisma.sql`${d}::timestamptz AT TIME ZONE 'UTC'`
  const utcOrNull = (d: Date | null | undefined) =>
    d == null ? Prisma.sql`NULL` : utc(d)

  interface ListSpec {
    name: string
    outletId?: string | null
    salesMethod?: string | null
    priority?: number
    validFrom?: Date | null
    validTo?: Date | null
    isActive?: boolean
    createdAt?: Date | null
    items: Array<{ variantId: string; price: bigint }>
  }

  async function createList(spec: ListSpec): Promise<string> {
    const rows = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO price_lists (
        id, "tenantId", name, "outletId", "salesMethod",
        priority, "validFrom", "validTo", "isActive", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid(), ${tenantId}::uuid, ${`${spec.name} ${runId}`},
        ${spec.outletId ?? null}::uuid, ${spec.salesMethod ?? null},
        ${spec.priority ?? 0}, ${utcOrNull(spec.validFrom)}, ${utcOrNull(spec.validTo)},
        ${spec.isActive ?? true}, ${utc(spec.createdAt ?? new Date())}, now()
      )
      RETURNING id
    `
    const listId = rows[0]!.id

    for (const item of spec.items) {
      await dbOwner.$executeRaw`
        INSERT INTO price_list_items (id, "tenantId", "priceListId", "variantId", price, "updatedAt")
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${listId}::uuid, ${item.variantId}::uuid, ${item.price}, now())
      `
    }

    return listId
  }

  /** Narrows the discriminated union so a test can name the winning list. */
  function winningListId(resolved: ResolvedPrice): string {
    if (resolved.source.kind !== 'PRICE_LIST') {
      throw new Error(`Expected a PRICE_LIST source, got ${resolved.source.kind}`)
    }
    return resolved.source.priceListId
  }

  beforeAll(async () => {
    // The tenant row itself is global (no tenantId), so it needs no GUC.
    const tenantRows = await runUnscoped(
      () => dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
        VALUES (gen_random_uuid(), ${`price-test-${runId}`}, 'Price Resolver Test', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
        RETURNING id
      `
    )
    tenantId = tenantRows[0]!.id

    // Session-level (not transaction-local) so it stays bound for every fixture
    // insert below; safe here only because this client is pinned to one connection.
    await dbOwner.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, false)`, tenantId)

    const outletRows = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO outlets (id, "tenantId", code, name, status, "updatedAt")
      VALUES
        (gen_random_uuid(), ${tenantId}::uuid, 'MAIN', 'Main Outlet', 'ACTIVE', now()),
        (gen_random_uuid(), ${tenantId}::uuid, 'BR02', 'Second Outlet', 'ACTIVE', now())
      RETURNING id
    `
    outletId = outletRows[0]!.id
    otherOutletId = outletRows[1]!.id

    const productRows = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO products (id, "tenantId", name, slug, "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'Resolver Fixture', ${`resolver-fixture-${runId}`}, now())
      RETURNING id
    `
    productId = productRows[0]!.id
  })

  afterAll(async () => {
    // Tenant cascade clears outlets, products, variants, lists and items.
    await runUnscoped(() => dbOwner.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`)
    await dbApp.$disconnect()
    await dbOwner.$disconnect()
  })

  describe('fallback', () => {
    it('uses basePrice when no list holds the variant', async () => {
      const variantId = await createVariant(15_000n)

      const resolved = await asTenant(() =>
        priceService.resolve(variantId, { outletId, salesMethod: 'DINE_IN' })
      )

      expect(resolved.price).toBe(15_000n)
      expect(resolved.source.kind).toBe('BASE_PRICE')
    })

    it('throws VARIANT_NOT_FOUND for an unknown variant', async () => {
      await expect(asTenant(() => priceService.resolve(randomUUID(), { outletId }))).rejects.toThrow(
        /not found/i
      )
    })
  })

  describe('specificity ordering', () => {
    it('a global list beats basePrice', async () => {
      const variantId = await createVariant(15_000n)
      const listId = await createList({
        name: 'Global',
        items: [{ variantId, price: 14_000n }],
      })

      const resolved = await asTenant(() =>
        priceService.resolve(variantId, { outletId, salesMethod: 'DINE_IN' })
      )

      expect(resolved.price).toBe(14_000n)
      expect(winningListId(resolved)).toBe(listId)
    })

    it('a salesMethod-only list beats a global list', async () => {
      const variantId = await createVariant(15_000n)
      await createList({ name: 'Global', items: [{ variantId, price: 14_000n }] })
      const methodListId = await createList({
        name: 'Takeaway',
        salesMethod: 'TAKEAWAY',
        items: [{ variantId, price: 13_000n }],
      })

      const resolved = await asTenant(() =>
        priceService.resolve(variantId, { outletId, salesMethod: 'TAKEAWAY' })
      )

      expect(resolved.price).toBe(13_000n)
      expect(winningListId(resolved)).toBe(methodListId)
    })

    it('an outlet-only list beats a salesMethod-only list', async () => {
      const variantId = await createVariant(15_000n)
      await createList({
        name: 'Takeaway',
        salesMethod: 'TAKEAWAY',
        items: [{ variantId, price: 13_000n }],
      })
      const outletListId = await createList({
        name: 'Main outlet',
        outletId,
        items: [{ variantId, price: 12_000n }],
      })

      const resolved = await asTenant(() =>
        priceService.resolve(variantId, { outletId, salesMethod: 'TAKEAWAY' })
      )

      expect(resolved.price).toBe(12_000n)
      expect(winningListId(resolved)).toBe(outletListId)
    })

    it('an outlet+salesMethod list beats every less specific list', async () => {
      const variantId = await createVariant(15_000n)
      await createList({ name: 'Global', items: [{ variantId, price: 14_000n }] })
      await createList({
        name: 'Takeaway',
        salesMethod: 'TAKEAWAY',
        items: [{ variantId, price: 13_000n }],
      })
      await createList({ name: 'Main outlet', outletId, items: [{ variantId, price: 12_000n }] })
      const bothListId = await createList({
        name: 'Main takeaway',
        outletId,
        salesMethod: 'TAKEAWAY',
        items: [{ variantId, price: 11_000n }],
      })

      const resolved = await asTenant(() =>
        priceService.resolve(variantId, { outletId, salesMethod: 'TAKEAWAY' })
      )

      expect(resolved.price).toBe(11_000n)
      expect(winningListId(resolved)).toBe(bothListId)
    })

    /**
     * The interpretation this suite exists to pin down. If `priority` could
     * outrank specificity, a tenant-wide list with priority 999 would silently
     * override every per-outlet price — which makes per-outlet pricing
     * unreliable, so specificity wins and `priority` only breaks ties.
     */
    it('specificity outranks priority', async () => {
      const variantId = await createVariant(15_000n)
      await createList({
        name: 'Loud global',
        priority: 1000,
        items: [{ variantId, price: 9_000n }],
      })
      const outletListId = await createList({
        name: 'Quiet outlet',
        outletId,
        priority: 0,
        items: [{ variantId, price: 12_000n }],
      })

      const resolved = await asTenant(() =>
        priceService.resolve(variantId, { outletId, salesMethod: 'DINE_IN' })
      )

      expect(resolved.price).toBe(12_000n)
      expect(winningListId(resolved)).toBe(outletListId)
    })
  })

  describe('tie-breaking within a tier', () => {
    it('higher priority wins', async () => {
      const variantId = await createVariant(15_000n)
      await createList({
        name: 'Low',
        outletId,
        salesMethod: 'DINE_IN',
        priority: 5,
        items: [{ variantId, price: 12_000n }],
      })
      const highId = await createList({
        name: 'High',
        outletId,
        salesMethod: 'DINE_IN',
        priority: 10,
        items: [{ variantId, price: 11_000n }],
      })

      const resolved = await asTenant(() =>
        priceService.resolve(variantId, { outletId, salesMethod: 'DINE_IN' })
      )

      expect(resolved.price).toBe(11_000n)
      expect(winningListId(resolved)).toBe(highId)
    })

    it('newest createdAt wins at equal priority', async () => {
      const variantId = await createVariant(15_000n)
      const now = Date.now()

      // createdAt is written explicitly rather than relying on insert order —
      // two inserts in the same millisecond would make the assertion flaky.
      await createList({
        name: 'Older',
        outletId,
        priority: 10,
        createdAt: new Date(now - 2 * HOUR),
        items: [{ variantId, price: 12_000n }],
      })
      const newerId = await createList({
        name: 'Newer',
        outletId,
        priority: 10,
        createdAt: new Date(now - 1 * HOUR),
        items: [{ variantId, price: 11_500n }],
      })

      const resolved = await asTenant(() => priceService.resolve(variantId, { outletId }))

      expect(resolved.price).toBe(11_500n)
      expect(winningListId(resolved)).toBe(newerId)
    })
  })

  describe('eligibility', () => {
    it('ignores an inactive list', async () => {
      const variantId = await createVariant(15_000n)
      await createList({
        name: 'Retired promo',
        outletId,
        isActive: false,
        items: [{ variantId, price: 5_000n }],
      })

      const resolved = await asTenant(() => priceService.resolve(variantId, { outletId }))

      expect(resolved.price).toBe(15_000n)
      expect(resolved.source.kind).toBe('BASE_PRICE')
    })

    it('ignores a list whose window has not opened yet', async () => {
      const variantId = await createVariant(15_000n)
      const at = new Date()
      await createList({
        name: 'Scheduled',
        outletId,
        validFrom: new Date(at.getTime() + HOUR),
        items: [{ variantId, price: 5_000n }],
      })

      const resolved = await asTenant(() => priceService.resolve(variantId, { outletId, at }))

      expect(resolved.source.kind).toBe('BASE_PRICE')
    })

    it('ignores a list whose window has closed', async () => {
      const variantId = await createVariant(15_000n)
      const at = new Date()
      await createList({
        name: 'Expired',
        outletId,
        validTo: new Date(at.getTime() - HOUR),
        items: [{ variantId, price: 5_000n }],
      })

      const resolved = await asTenant(() => priceService.resolve(variantId, { outletId, at }))

      expect(resolved.source.kind).toBe('BASE_PRICE')
    })

    it('applies a scheduled list once `at` falls inside its window', async () => {
      const variantId = await createVariant(15_000n)
      const opensAt = new Date(Date.now() + HOUR)
      const listId = await createList({
        name: 'Happy hour',
        outletId,
        validFrom: opensAt,
        validTo: new Date(opensAt.getTime() + HOUR),
        items: [{ variantId, price: 5_000n }],
      })

      // Same fixture, evaluated inside the window — `at` exists so a scheduled
      // price is testable without waiting for the clock.
      const resolved = await asTenant(() =>
        priceService.resolve(variantId, { outletId, at: new Date(opensAt.getTime() + 60_000) })
      )

      expect(resolved.price).toBe(5_000n)
      expect(winningListId(resolved)).toBe(listId)
    })

    it('does not leak another outlet’s list into this outlet', async () => {
      const variantId = await createVariant(15_000n)
      await createList({
        name: 'Second outlet only',
        outletId: otherOutletId,
        items: [{ variantId, price: 5_000n }],
      })

      const resolved = await asTenant(() => priceService.resolve(variantId, { outletId }))

      expect(resolved.source.kind).toBe('BASE_PRICE')
      expect(resolved.price).toBe(15_000n)
    })

    it('applies only global lists when the context names no outlet or method', async () => {
      const variantId = await createVariant(15_000n)
      const globalId = await createList({
        name: 'Global',
        items: [{ variantId, price: 14_000n }],
      })
      await createList({
        name: 'Outlet scoped',
        outletId,
        priority: 100,
        items: [{ variantId, price: 5_000n }],
      })

      const resolved = await asTenant(() => priceService.resolve(variantId, {}))

      expect(resolved.price).toBe(14_000n)
      expect(winningListId(resolved)).toBe(globalId)
    })
  })

  describe('batch', () => {
    it('resolves each variant independently in one call', async () => {
      const listPricedId = await createVariant(15_000n)
      const basePricedId = await createVariant(25_000n)
      const winnerId = await createList({
        name: 'Batch',
        outletId,
        items: [{ variantId: listPricedId, price: 12_000n }],
      })

      const resolved = await asTenant(() =>
        priceService.resolveMany([listPricedId, basePricedId], { outletId })
      )

      expect(resolved.size).toBe(2)
      expect(resolved.get(listPricedId)?.price).toBe(12_000n)
      expect(winningListId(resolved.get(listPricedId)!)).toBe(winnerId)
      expect(resolved.get(basePricedId)?.price).toBe(25_000n)
      expect(resolved.get(basePricedId)?.source.kind).toBe('BASE_PRICE')
    })

    it('returns an empty map for an empty request', async () => {
      const resolved = await asTenant(() => priceService.resolveMany([], { outletId }))
      expect(resolved.size).toBe(0)
    })

    it('omits unknown variant ids rather than inventing a price', async () => {
      const variantId = await createVariant(15_000n)
      const unknownId = randomUUID()

      const resolved = await asTenant(() =>
        priceService.resolveMany([variantId, unknownId], { outletId })
      )

      expect(resolved.size).toBe(1)
      expect(resolved.has(unknownId)).toBe(false)
    })
  })
})
