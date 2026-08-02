/**
 * S8-06 DoD — QR self-service order flow, the parts that need a real database.
 *
 * The security AC (design §16.2) is that a public, unauthenticated request maps
 * to a tenant/outlet/table ONLY through the QR token — never client input. These
 * tests drive `QrOrderService` directly (no HTTP; the rate limiter is a route
 * concern) under the app role with scoping live, so a regression in tenant
 * scoping fails here too.
 *
 * Covered:
 *   - token isolation: a token resolves to its own table only; a garbage token
 *     is an opaque QR_INVALID (404).
 *   - auto-accept ON: the placed order lands SENT (accepted:true), table OCCUPIED.
 *   - auto-accept OFF: the placed order stays OPEN (accepted:false); a staff
 *     send() then routes it to SENT.
 *   - feature off: `qrOrder` disabled → resolve-then-menu/place both 404 opaque.
 *   - one active order per table: a second QR order on an occupied table → 409.
 *
 * Fixtures are written as the owner (RLS is FORCEd); the owner client is pinned
 * to one connection so the session GUC stays bound across inserts.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPrismaClient, createSystemPrismaClient, runWithTenantContext } from '@brewsync/db'
import { QrOrderService } from '../src/services/qr-order.service.js'
import { OrderService } from '../src/services/order.service.js'

loadEnv({ path: resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

const APP_ROLE_URL = process.env.TEST_DATABASE_URL!
const OWNER_ROLE_URL = withConnectionLimitOne(process.env.TEST_DIRECT_DATABASE_URL!)

function withConnectionLimitOne(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`
}

/** All S8 feature toggles the QR flow needs on. */
const QR_FEATURES = { tables: true, qrOrder: true }

describe('S8-06 — QR order flow', () => {
  const dbApp = createPrismaClient({ datasourceUrl: APP_ROLE_URL })
  const dbOwner = createPrismaClient({ datasourceUrl: OWNER_ROLE_URL })
  // The system client backs resolveTable's cross-tenant read (BYPASSRLS); the
  // app client stays RLS-subject for everything tenant-scoped.
  const dbSystem = createSystemPrismaClient({ datasourceUrl: process.env.TEST_UNSCOPED_DATABASE_URL ?? '' })
  const qr = new QrOrderService(dbApp, dbSystem)
  const orders = new OrderService(dbApp)

  const runId = randomUUID().slice(0, 8)
  let tenantId: string
  let outletId: string
  let variantId: string
  /** Distinct tokens for distinct tables so isolation is provable. */
  let tokenAuto: string
  let tokenManual: string

  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenantContext({ tenantId, outletId }, async () => await fn())

  /** Flips the outlet's auto-accept toggle (owner, GUC already bound). */
  async function setAutoAccept(value: boolean): Promise<void> {
    await dbOwner.$executeRaw`
      UPDATE outlets SET "qrAutoAccept" = ${value} WHERE id = ${outletId}::uuid
    `
  }

  /** Sets the tenant's feature flags (owner). */
  async function setFeatures(features: Record<string, boolean>): Promise<void> {
    await dbOwner.$executeRaw`
      UPDATE business_profiles SET features = ${JSON.stringify(features)}::jsonb, "updatedAt" = now()
      WHERE "tenantId" = ${tenantId}::uuid
    `
  }

  beforeAll(async () => {
    const [tenant] = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
      VALUES (gen_random_uuid(), ${`qr-${runId}`}, 'QR Test', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
      RETURNING id
    `
    tenantId = tenant!.id
    // RLS is FORCEd, so the owner role is subject to it too. The owner client is
    // pinned to one connection (connection_limit=1), so this session-level GUC
    // stays bound across every tenant-scoped insert below.
    await dbOwner.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, false)`, tenantId)

    await dbOwner.$executeRaw`
      INSERT INTO business_profiles (id, "tenantId", preset, features, "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'FNB', ${JSON.stringify(QR_FEATURES)}::jsonb, now())
    `

    // Zero tax + no rounding so the bill pipeline accepts the QR order.
    const [outlet] = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO outlets (id, "tenantId", code, name, status, "taxRateBp", "roundingIncrement", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'MAIN', 'Main', 'ACTIVE', 0, 0, now())
      RETURNING id
    `
    outletId = outlet!.id

    const [product] = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO products (id, "tenantId", name, slug, "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'QR Fixture', ${`qr-fixture-${runId}`}, now())
      RETURNING id
    `
    const [variant] = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO product_variants (id, "tenantId", "productId", sku, name, "basePrice", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${product!.id}::uuid, ${`SKU-${runId}`}, 'Kopi', 15000, now())
      RETURNING id
    `
    variantId = variant!.id

    tokenAuto = `qr-auto-${runId}`
    tokenManual = `qr-manual-${runId}`
    await dbOwner.$executeRaw`
      INSERT INTO tables (id, "tenantId", "outletId", code, name, "qrToken", "updatedAt")
      VALUES
        (gen_random_uuid(), ${tenantId}::uuid, ${outletId}::uuid, 'T1', 'Table 1', ${tokenAuto}, now()),
        (gen_random_uuid(), ${tenantId}::uuid, ${outletId}::uuid, 'T2', 'Table 2', ${tokenManual}, now())
    `
  })

  afterAll(async () => {
    await dbOwner.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`
    await dbApp.$disconnect()
    await dbOwner.$disconnect()
    await dbSystem.$disconnect()
  })

  it('resolves a token to its own table and rejects a garbage token opaquely', async () => {
    const resolved = await qr.resolveTable(tokenAuto)
    expect(resolved.tenantId).toBe(tenantId)
    expect(resolved.outletId).toBe(outletId)
    expect(resolved.tableName).toBe('Table 1')

    await expect(qr.resolveTable('not-a-real-token')).rejects.toMatchObject({
      status: 404,
      code: 'QR_INVALID',
    })
  })

  it('serves the dine-in menu with a resolved price', async () => {
    const resolved = await qr.resolveTable(tokenAuto)
    const menu = await qr.menu(resolved)
    const row = menu.variants.find((v) => v.variantId === variantId)
    expect(row).toBeDefined()
    expect(row!.price).toBe('15000')
  })

  it('auto-accept ON: the placed order lands SENT and the table is OCCUPIED', async () => {
    await setAutoAccept(true)
    const resolved = await qr.resolveTable(tokenAuto)

    const { order, accepted } = await qr.placeOrder(resolved, [{ variantId, qty: 2 }])
    expect(accepted).toBe(true)
    expect(order!.status).toBe('SENT')
    expect(order!.channel).toBe('QR_TABLE')
    expect(order!.tableId).toBe(resolved.tableId)

    const table = await dbOwner.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM tables WHERE id = ${resolved.tableId}::uuid
    `
    expect(table[0]!.status).toBe('OCCUPIED')
  })

  it('one active order per table: a second QR order on the occupied table is 409', async () => {
    const resolved = await qr.resolveTable(tokenAuto)
    await expect(qr.placeOrder(resolved, [{ variantId, qty: 1 }])).rejects.toMatchObject({
      status: 409,
    })
  })

  it('auto-accept OFF: the placed order stays OPEN, then a staff send routes it', async () => {
    await setAutoAccept(false)
    const resolved = await qr.resolveTable(tokenManual)

    const { order, accepted } = await qr.placeOrder(resolved, [{ variantId, qty: 1 }])
    expect(accepted).toBe(false)
    expect(order!.status).toBe('OPEN')

    // Staff "accept" = the existing authenticated send action.
    const sent = await asTenant(() => orders.send(order!.id))
    expect(sent!.status).toBe('SENT')
  })

  it('feature off: qrOrder disabled masks menu and placement as QR_INVALID', async () => {
    await setFeatures({ tables: true, qrOrder: false })
    // A valid token still resolves (resolve does not gate on the feature)...
    const resolved = await qr.resolveTable(tokenManual)
    // ...but the menu and placement are opaque 404s.
    await expect(qr.menu(resolved)).rejects.toMatchObject({ status: 404, code: 'QR_INVALID' })
    await expect(qr.placeOrder(resolved, [{ variantId, qty: 1 }])).rejects.toMatchObject({
      status: 404,
      code: 'QR_INVALID',
    })
    await setFeatures(QR_FEATURES)
  })
})
