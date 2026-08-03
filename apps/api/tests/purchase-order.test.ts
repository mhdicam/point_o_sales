/**
 * S6-06/07/08 DoD — PurchaseOrder invariants that fail *quietly* if they regress.
 *
 * Behaviours the design (§4.5) pins down and the state test cannot reach, because
 * they only exist against a real database:
 *   - poNumber is a per-tenant sequence: the first PO is 1, the next is 2. A
 *     regression that reused the same number would collide on the unique index.
 *   - APPROVED is the snapshot moment (standard #7): approve freezes each line's
 *     lineTotal from unitCost × qty and computes subtotal/tax/total once. The
 *     arithmetic must match the shared minor-unit helpers exactly.
 *   - the lifecycle is guarded by the state machine: approve is illegal straight
 *     from DRAFT (a PO must be SUBMITTED first) and surfaces as a 409, not a 500.
 *   - a cancel needs a reason — an empty one is rejected before any write.
 *   - goods receipt (S6-07/08) is the ONE place a PO moves stock: a receipt
 *     appends a PURCHASE StockMovement (raising on-hand + feeding valuation),
 *     accumulates qtyReceivedScaled, and derives status — partial → RECEIVING,
 *     full → RECEIVED. Over-receipt is rejected; GoodsReceived lands in the outbox.
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
import { PurchaseOrderService } from '../src/services/purchase-order.service.js'
import { StockService } from '../src/services/stock.service.js'

loadEnv({ path: resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

const APP_ROLE_URL = process.env.TEST_DATABASE_URL!
const OWNER_ROLE_URL = withConnectionLimitOne(process.env.TEST_DIRECT_DATABASE_URL!)

/**
 * Pin the owner client to one connection so a session-level GUC persists across
 * the raw fixture inserts (and the raw outbox read in the assertions below).
 */
function withConnectionLimitOne(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`
}

// One base unit, scaled — the qty helper's unit. Keeps the fixtures readable.
const SCALE = 1_000_000n

describe('S6-06 — purchase order', () => {
  const dbApp = createPrismaClient({ datasourceUrl: APP_ROLE_URL })
  const dbOwner = createPrismaClient({ datasourceUrl: OWNER_ROLE_URL })
  const pos = new PurchaseOrderService(dbApp)
  const stock = new StockService(dbApp)

  const runId = randomUUID().slice(0, 8)
  let tenantId: string
  let outletId: string
  let supplierId: string
  let variantA: string
  let variantB: string

  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenantContext({ tenantId }, async () => await fn())

  beforeAll(async () => {
    // Tenant + the master rows a PO references. Raw inserts as owner (unscoped)
    // so the seed itself does not depend on the code under test.
    await runUnscoped(async () => {
      const [tenant] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
        VALUES (gen_random_uuid(), ${`po-${runId}`}, 'PO Test', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
        RETURNING id
      `
      tenantId = tenant!.id

      // RLS is FORCEd, so even the owner is subject to it. The owner client is
      // pinned to one connection, so this session-level GUC stays bound across
      // every tenant-scoped insert below (and the raw outbox read in a test).
      await dbOwner.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, false)`, tenantId)

      const [outlet] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO outlets (id, "tenantId", code, name, status, "updatedAt")
        VALUES (gen_random_uuid(), ${tenantId}::uuid, 'MAIN', 'Main', 'ACTIVE', now())
        RETURNING id
      `
      outletId = outlet!.id

      const [supplier] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO suppliers (id, "tenantId", code, name, "paymentTermDays", "defaultCurrency", "isActive", "updatedAt")
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${`SUP-${runId}`}, 'Acme', 0, 'IDR', true, now())
        RETURNING id
      `
      supplierId = supplier!.id

      const [product] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO products (id, "tenantId", name, slug, "fulfillmentType", "isActive", "updatedAt")
        VALUES (gen_random_uuid(), ${tenantId}::uuid, 'Beans', ${`beans-${runId}`}, 'STOCKED', true, now())
        RETURNING id
      `
      const productId = product!.id

      // A base unit (factor = SCALE) attached to both variants, so received base
      // units and reported on-hand stock units line up 1:1 in the assertions.
      const [unit] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO units (id, "tenantId", code, name, dimension, factor, "isActive", "updatedAt")
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${`KG-${runId}`}, 'Kilogram', 'WEIGHT', ${SCALE}, true, now())
        RETURNING id
      `
      const unitId = unit!.id

      const variants = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO product_variants (id, "tenantId", "productId", name, sku, "stockUnitId", "isActive", "updatedAt")
        VALUES
          (gen_random_uuid(), ${tenantId}::uuid, ${productId}::uuid, 'A', ${`A-${runId}`}, ${unitId}::uuid, true, now()),
          (gen_random_uuid(), ${tenantId}::uuid, ${productId}::uuid, 'B', ${`B-${runId}`}, ${unitId}::uuid, true, now())
        RETURNING id
      `
      variantA = variants[0]!.id
      variantB = variants[1]!.id
    })
  })

  afterAll(async () => {
    await runUnscoped(() => dbOwner.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`)
    await dbApp.$disconnect()
    await dbOwner.$disconnect()
  })

  it('assigns poNumber as a per-tenant sequence starting at 1', async () => {
    const first = await asTenant(() =>
      pos.create({
        outletId,
        supplierId,
        items: [{ variantId: variantA, qtyOrderedScaled: 5n * SCALE, unitCost: 10_000n }],
      })
    )
    expect(first.poNumber).toBe(1)
    expect(first.status).toBe('DRAFT')

    const second = await asTenant(() =>
      pos.create({
        outletId,
        supplierId,
        items: [{ variantId: variantB, qtyOrderedScaled: 1n * SCALE, unitCost: 2_500n }],
      })
    )
    expect(second.poNumber).toBe(2)
  })

  it('freezes line totals and computes subtotal/tax/total at APPROVED', async () => {
    // 3 × 10_000 + 2 × 25_000 = 80_000 subtotal; 11% tax = 8_800; total 88_800.
    const draft = await asTenant(() =>
      pos.create({
        outletId,
        supplierId,
        taxRateBp: 1100,
        items: [
          { variantId: variantA, qtyOrderedScaled: 3n * SCALE, unitCost: 10_000n },
          { variantId: variantB, qtyOrderedScaled: 2n * SCALE, unitCost: 25_000n },
        ],
      })
    )

    await asTenant(() => pos.submit(draft.id))
    const approved = await asTenant(() => pos.approve(draft.id))

    expect(approved.status).toBe('APPROVED')
    expect(approved.subtotal).toBe(80_000n)
    expect(approved.taxAmount).toBe(8_800n)
    expect(approved.total).toBe(88_800n)
    expect(approved.approvedAt).not.toBeNull()

    const lineTotals = approved.items.map((i) => i.lineTotal).sort((a, b) => (a < b ? -1 : 1))
    expect(lineTotals).toEqual([30_000n, 50_000n])
  })

  it('rejects approve straight from DRAFT with a 409, not a 500', async () => {
    const draft = await asTenant(() =>
      pos.create({
        outletId,
        supplierId,
        items: [{ variantId: variantA, qtyOrderedScaled: 1n * SCALE, unitCost: 1_000n }],
      })
    )
    // Never SUBMITTED — the machine forbids DRAFT → APPROVED. The service maps
    // IllegalTransitionError to a 409 reading "cannot move from DRAFT to APPROVED…".
    await expect(asTenant(() => pos.approve(draft.id))).rejects.toThrow(/cannot move from|Allowed from/i)
  })

  it('requires a reason to cancel', async () => {
    const draft = await asTenant(() =>
      pos.create({
        outletId,
        supplierId,
        items: [{ variantId: variantA, qtyOrderedScaled: 1n * SCALE, unitCost: 1_000n }],
      })
    )
    await expect(asTenant(() => pos.cancel(draft.id, '   '))).rejects.toThrow(/reason/i)

    const cancelled = await asTenant(() => pos.cancel(draft.id, 'duplicate order'))
    expect(cancelled.status).toBe('CANCELLED')
    expect(cancelled.cancelReason).toBe('duplicate order')
  })

  /** Drafts, submits and approves a PO so it is ready to receive against. */
  const approvedPo = (items: { variantId: string; qtyOrderedScaled: bigint; unitCost: bigint }[]) =>
    asTenant(async () => {
      const draft = await pos.create({ outletId, supplierId, items })
      await pos.submit(draft.id)
      return pos.approve(draft.id)
    })

  it('receives goods in stages: partial → RECEIVING, remainder → RECEIVED', async () => {
    const po = await approvedPo([
      { variantId: variantA, qtyOrderedScaled: 10n * SCALE, unitCost: 3_000n },
    ])
    const lineId = po.items[0]!.id

    // Receive 4 of 10 → RECEIVING; on-hand rises by exactly the received qty.
    const partial = await asTenant(() =>
      pos.receive(po.id, { lines: [{ poItemId: lineId, qtyScaled: 4n * SCALE }] })
    )
    expect(partial.status).toBe('RECEIVING')
    expect(partial.items[0]!.qtyReceivedScaled).toBe(4n * SCALE)

    const afterPartial = await asTenant(() => stock.onHand(outletId, variantA))
    expect(afterPartial.onHandBaseScaled).toBe(4n * SCALE)
    // costPerUnit was frozen at APPROVED, so valuation = 4 × 3_000 = 12_000.
    expect(afterPartial.value).toBe(12_000n)

    // Receive the remaining 6 → RECEIVED; on-hand is the full 10.
    const full = await asTenant(() =>
      pos.receive(po.id, { lines: [{ poItemId: lineId, qtyScaled: 6n * SCALE }] })
    )
    expect(full.status).toBe('RECEIVED')
    expect(full.items[0]!.qtyReceivedScaled).toBe(10n * SCALE)

    const afterFull = await asTenant(() => stock.onHand(outletId, variantA))
    expect(afterFull.onHandBaseScaled).toBe(10n * SCALE)
  })

  it('reaches RECEIVED in one receipt when every line arrives in full', async () => {
    const po = await approvedPo([
      { variantId: variantA, qtyOrderedScaled: 2n * SCALE, unitCost: 1_000n },
      { variantId: variantB, qtyOrderedScaled: 3n * SCALE, unitCost: 2_000n },
    ])
    const received = await asTenant(() =>
      pos.receive(po.id, {
        lines: po.items.map((i) => ({ poItemId: i.id, qtyScaled: i.qtyOrderedScaled })),
      })
    )
    expect(received.status).toBe('RECEIVED')
    expect(received.items.every((i) => i.qtyReceivedScaled === i.qtyOrderedScaled)).toBe(true)
  })

  it('rejects receiving more than a line has outstanding', async () => {
    const po = await approvedPo([
      { variantId: variantA, qtyOrderedScaled: 2n * SCALE, unitCost: 1_000n },
    ])
    await expect(
      asTenant(() =>
        pos.receive(po.id, { lines: [{ poItemId: po.items[0]!.id, qtyScaled: 3n * SCALE }] })
      )
    ).rejects.toThrow(/OVER_RECEIPT|outstanding/i)
  })

  it('refuses a receipt before APPROVED (409, not a silent stock move)', async () => {
    const draft = await asTenant(() =>
      pos.create({
        outletId,
        supplierId,
        items: [{ variantId: variantA, qtyOrderedScaled: 1n * SCALE, unitCost: 1_000n }],
      })
    )
    await expect(
      asTenant(() =>
        pos.receive(draft.id, { lines: [{ poItemId: draft.items[0]!.id, qtyScaled: 1n * SCALE }] })
      )
    ).rejects.toThrow(/NOT_RECEIVABLE|APPROVED/i)
  })

  it('emits GoodsReceived to the outbox on a receipt', async () => {
    const po = await approvedPo([
      { variantId: variantB, qtyOrderedScaled: 1n * SCALE, unitCost: 5_000n },
    ])
    await asTenant(() =>
      pos.receive(po.id, { lines: [{ poItemId: po.items[0]!.id, qtyScaled: 1n * SCALE }] })
    )

    const events = await runUnscoped(
      () =>
        dbOwner.$queryRaw<Array<{ type: string }>>`
          SELECT type FROM outbox_events
          WHERE "tenantId" = ${tenantId}::uuid AND type = 'GoodsReceived'
        `
    )
    expect(events.length).toBeGreaterThanOrEqual(1)
  })
})
