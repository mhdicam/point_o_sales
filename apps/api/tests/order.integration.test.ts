/**
 * S4 — Order integration: the snapshot boundary, the OPEN-only guard, and the
 * transactional void. Design §6/§7, standards #4 and #7.
 *
 * Runs through the real OrderService under a real tenant context (no manual
 * tenantId — standard #1), against the app role with scoping live. Three things
 * that only a DB-backed test can prove:
 *
 *   1. SENT freezes the line. After send(), editing the variant's master price
 *      must not move the line's charges — the snapshot, not the live price, is
 *      what the bill reads.
 *   2. Items are editable only while OPEN. A mutation after SENT is a 409.
 *   3. void() writes its OutboxEvent in the SAME transaction as the status flip
 *      (standard #4) — the row is there, and it carries the tenant.
 *
 * Fixtures are written as the owner because RLS is FORCEd; the owner client is
 * pinned to one connection so the session-level GUC stays bound for every insert.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPrismaClient, runUnscoped, runWithTenantContext } from '@brewsync/db'
import { OrderService } from '../src/services/order.service.js'

loadEnv({ path: resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

const APP_ROLE_URL = process.env.TEST_DATABASE_URL!
const OWNER_ROLE_URL = withConnectionLimitOne(process.env.TEST_DIRECT_DATABASE_URL!)

function withConnectionLimitOne(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`
}

describe('S4 — order integration', () => {
  const dbApp = createPrismaClient({ datasourceUrl: APP_ROLE_URL })
  const dbOwner = createPrismaClient({ datasourceUrl: OWNER_ROLE_URL })
  const orders = new OrderService(dbApp)

  const runId = randomUUID().slice(0, 8)
  let tenantId: string
  let outletId: string
  let productId: string

  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenantContext({ tenantId, outletId, userId: undefined }, async () => await fn())

  let variantSeq = 0
  async function createVariant(basePrice: bigint, name = 'Kopi'): Promise<string> {
    const sku = `SKU-${runId}-${++variantSeq}`
    const rows = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO product_variants (id, "tenantId", "productId", sku, name, "basePrice", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${productId}::uuid, ${sku}, ${name}, ${basePrice}, now())
      RETURNING id
    `
    return rows[0]!.id
  }

  async function setVariantPrice(variantId: string, price: bigint): Promise<void> {
    await dbOwner.$executeRaw`
      UPDATE product_variants SET "basePrice" = ${price}, "updatedAt" = now() WHERE id = ${variantId}::uuid
    `
  }

  beforeAll(async () => {
    const tenantRows = await runUnscoped(
      () => dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
        VALUES (gen_random_uuid(), ${`order-test-${runId}`}, 'Order Test', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
        RETURNING id
      `
    )
    tenantId = tenantRows[0]!.id

    await dbOwner.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, false)`, tenantId)

    // Exclusive 11% tax, no service charge, round to 1 — a clean base for asserting
    // the snapshot moves nothing.
    const outletRows = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO outlets (id, "tenantId", code, name, status, "taxInclusive", "taxRateBp", "serviceChargeRateBp", "roundingIncrement", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'MAIN', 'Main Outlet', 'ACTIVE', false, 1100, 0, 1, now())
      RETURNING id
    `
    outletId = outletRows[0]!.id

    const productRows = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO products (id, "tenantId", name, slug, "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'Order Fixture', ${`order-fixture-${runId}`}, now())
      RETURNING id
    `
    productId = productRows[0]!.id
  })

  afterAll(async () => {
    await runUnscoped(() => dbOwner.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`)
    await dbApp.$disconnect()
    await dbOwner.$disconnect()
  })

  describe('snapshot at SENT (standard #7)', () => {
    it('freezes the line price so a later master-price edit does not move the bill', async () => {
      const variantId = await createVariant(100_000n)

      const created = await asTenant(() => orders.create({ outletId, items: [{ variantId, qty: 1 }] }))
      const orderId = created!.id

      // While OPEN the bill tracks the live price: 100000 + 11% = 111000.
      const beforeSend = created!.charges.find((c) => c.kind === 'TAX')
      expect(beforeSend?.amount).toBe(11_000n)

      const sent = await asTenant(() => orders.send(orderId))
      const item = sent!.items[0]!
      expect(item.priceSnapshot).toBe(100_000n)
      expect(item.nameSnapshot).toBe('Kopi')
      const taxAtSend = sent!.charges.find((c) => c.kind === 'TAX')!
      expect(taxAtSend.amount).toBe(11_000n)

      // Master price changes AFTER send — the frozen line must ignore it.
      await setVariantPrice(variantId, 999_000n)

      const reloaded = await asTenant(() => orders.getById(orderId))
      expect(reloaded.items[0]!.priceSnapshot).toBe(100_000n)
      const taxAfterEdit = reloaded.charges.find((c) => c.kind === 'TAX')!
      expect(taxAfterEdit.amount).toBe(11_000n)
    })
  })

  describe('OPEN-only mutation guard', () => {
    it('rejects addItem after SENT with a 409', async () => {
      const variantId = await createVariant(50_000n)
      const created = await asTenant(() => orders.create({ outletId, items: [{ variantId, qty: 1 }] }))
      const orderId = created!.id

      await asTenant(() => orders.send(orderId))

      await expect(
        asTenant(() => orders.addItem(orderId, { variantId, qty: 1 }))
      ).rejects.toMatchObject({ status: 409 })
    })

    it('rejects an illegal transition (OPEN → BILLED) with a 409', async () => {
      const variantId = await createVariant(50_000n)
      const created = await asTenant(() => orders.create({ outletId, items: [{ variantId, qty: 1 }] }))

      await expect(asTenant(() => orders.bill(created!.id))).rejects.toMatchObject({ status: 409 })
    })
  })

  describe('charge lifecycle', () => {
    it('freezes charges at BILLED — they do not change after', async () => {
      const variantId = await createVariant(100_000n)
      const created = await asTenant(() => orders.create({ outletId, items: [{ variantId, qty: 1 }] }))
      const orderId = created!.id

      await asTenant(() => orders.send(orderId))
      const billed = await asTenant(() => orders.bill(orderId))

      expect(billed!.status).toBe('BILLED')
      expect(billed!.billedAt).not.toBeNull()
      const taxRow = billed!.charges.find((c) => c.kind === 'TAX')!
      expect(taxRow.amount).toBe(11_000n)

      // A discount attempt after BILLED is refused — charges are frozen.
      await expect(
        asTenant(() => orders.applyOrderDiscount(orderId, { label: 'late', rateBp: 1000 }))
      ).rejects.toMatchObject({ status: 409 })
    })

    it('rewrites charges on recompute — an order discount lands as a negative row', async () => {
      const variantId = await createVariant(100_000n)
      const created = await asTenant(() => orders.create({ outletId, items: [{ variantId, qty: 1 }] }))
      const orderId = created!.id

      const discounted = await asTenant(() =>
        orders.applyOrderDiscount(orderId, { label: '10% off', rateBp: 1000 })
      )

      const disc = discounted!.charges.find((c) => c.kind === 'DISCOUNT')!
      expect(disc.amount).toBe(-10_000n)
      // subtotal 100000 − 10000 = 90000; tax 9900; total 99900.
      const tax = discounted!.charges.find((c) => c.kind === 'TAX')!
      expect(tax.amount).toBe(9_900n)
    })
  })

  describe('void emits an OutboxEvent in the same transaction (standard #4)', () => {
    it('writes exactly one OrderVoided row carrying the tenant', async () => {
      const variantId = await createVariant(100_000n)
      const created = await asTenant(() => orders.create({ outletId, items: [{ variantId, qty: 1 }] }))
      const orderId = created!.id

      const voided = await asTenant(() => orders.void(orderId))
      expect(voided!.status).toBe('VOID')

      const events = await asTenant(() =>
        dbApp.outboxEvent.findMany({ where: { type: 'OrderVoided' } })
      )
      const mine = events.filter((e) => {
        const payload = e.payload as { orderId?: string }
        return payload.orderId === orderId
      })
      expect(mine).toHaveLength(1)
      expect(mine[0]!.tenantId).toBe(tenantId)
      expect(mine[0]!.outletId).toBe(outletId)
    })

    it('voidItem emits ItemVoided then removes the line', async () => {
      const variantId = await createVariant(100_000n)
      const created = await asTenant(() =>
        orders.create({ outletId, items: [{ variantId, qty: 2 }] })
      )
      const orderId = created!.id
      const itemId = created!.items[0]!.id

      await asTenant(() => orders.send(orderId))
      const after = await asTenant(() => orders.voidItem(orderId, itemId))

      expect(after!.items).toHaveLength(0)
      const events = await asTenant(() =>
        dbApp.outboxEvent.findMany({ where: { type: 'ItemVoided' } })
      )
      const mine = events.filter((e) => {
        const payload = e.payload as { orderItemId?: string }
        return payload.orderItemId === itemId
      })
      expect(mine).toHaveLength(1)
    })
  })
})
