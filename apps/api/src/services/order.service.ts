/**
 * Order service — S4-03, design §6/§7.
 *
 * Orchestrates the order lifecycle: it owns no money math (that is the pure
 * `order.pipeline.ts`) and no transition truth (that is `order.state.ts`). Its
 * job is to compose those two with the price seam (`PriceService`) and the
 * transactional outbox, under the tenant guards — never touching `tenantId`
 * itself (standard #1; the Prisma extension injects it).
 *
 * Two timing rules govern the charge rows, and they are the subtle part:
 *
 *   1. Snapshot at SENT (standard #7). While OPEN a line has no frozen price —
 *      `recompute` resolves the live price through `PriceService` so the working
 *      bill reflects current master data. At SENT the price, name, and chosen
 *      modifier deltas freeze into the `*Snapshot` columns; from then on
 *      `recompute` reads the snapshot, so editing a variant's price afterwards
 *      never shifts a historical line.
 *
 *   2. Charges are working state until BILLED (per the plan's "persist on every
 *      recompute"). Every mutation runs the pipeline and **rewrites** the
 *      `OrderCharge` rows delete-then-insert. This gives a always-current read
 *      model without a separate cache. At BILLED the rows are frozen (the Bill
 *      snapshot moment, §7.1) and `recompute` is never called again.
 *
 * Discounts and gratuity are themselves `OrderCharge` rows, so they are durable
 * across the rewrite: `recompute` reads the existing DISCOUNT/GRATUITY rows,
 * reconstructs the pipeline inputs from them, then re-emits canonical rows. An
 * item discount carries `orderItemId` so it re-targets its line after the
 * rewrite; the pipeline emits item discounts before order discounts, so the
 * re-association is positional and deterministic.
 *
 * Every mutation runs inside `withTenantTransaction`: it binds the RLS GUC once
 * and marks the context `gucBound`, so all reads/writes below must go through the
 * transaction client `tx` (a plain `this.db` call would run on a different
 * connection that has no GUC bound and RLS would return nothing). Voids emit
 * their event in that same transaction (standard #4).
 *
 * Illegal transitions throw `IllegalTransitionError`, which the shared error
 * handler does not know; this service translates it to HTTP 409 at the boundary.
 */

import {
  type BrewsyncClient,
  type Prisma,
  type PrismaClient,
  type OutboxCapableTx,
  withTenantTransaction,
  requireTenantContext,
  emitEvent,
} from '@brewsync/db'
import { IllegalTransitionError, EVENT_TYPES } from '@brewsync/shared'
import { badRequest, conflict, notFound } from '../http-error.js'
import { PriceService } from './price.service.js'
import { orderStateMachine, isEditable, type OrderStatus } from './order.state.js'
import { tableStateMachine, type TableStatus } from './table.state.js'
import { classifyMergeCharges } from './table-ops.policy.js'
import { routeLine } from './kds-routing.policy.js'
import { FeatureService } from './feature.service.js'
import { StockDeductionService } from './stock-deduction.service.js'
import {
  runBillPipeline,
  type DiscountInput,
  type ItemDiscountInput,
  type FiscalConfig,
  type PipelineInput,
  type PipelineLine,
} from './order.pipeline.js'

/** States in which the bill is still working state — discounts and recompute are legal. */
const PRE_BILLED: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['OPEN', 'SENT', 'SERVED'])

/** States in which an order still physically occupies a table (transfer is legal). */
const ORDER_ON_FLOOR: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'OPEN',
  'SENT',
  'SERVED',
  'BILLED',
])

type Tx = Prisma.TransactionClient

export interface OrderItemInput {
  variantId: string
  qty: number
  /** Chosen modifiers (design §3.1). Resolved to a working delta now, refrozen at SENT. */
  modifierIds?: string[]
}

export interface CreateOrderInput {
  outletId: string
  channel?: 'STAFF' | 'QR_TABLE' | 'ONLINE'
  salesMethod?: string | null
  items?: OrderItemInput[]
}

/** One frozen modifier on a line, as stored in `modifiersSnapshot`. Delta is a string — JSON has no BigInt. */
interface ModifierSnapshotEntry {
  modifierId: string
  name: string
  priceDelta: string
}

export class OrderService {
  constructor(private readonly db: BrewsyncClient) {}

  /** Opens a new order (OPEN). Optionally seeds items in the same transaction. */
  async create(input: CreateOrderInput) {
    if (input.items && input.items.some((i) => i.qty <= 0)) {
      throw badRequest('INVALID_QTY', 'Item quantity must be a positive integer.')
    }

    return this.inTx(async (tx) => {
      await this.requireOutlet(tx, input.outletId)

      const order = await tx.order.create({
        data: {
          outletId: input.outletId,
          channel: input.channel ?? 'STAFF',
          salesMethod: input.salesMethod ?? null,
          status: 'OPEN',
        } as unknown as Prisma.OrderCreateInput,
        select: { id: true },
      })

      for (const item of input.items ?? []) {
        await this.insertItem(tx, order.id, item)
      }

      await this.recompute(tx, order.id)
      return this.load(tx, order.id)
    })
  }

  /** Adds a line. OPEN only (standard #7 — items freeze at SENT). */
  async addItem(orderId: string, input: OrderItemInput) {
    if (input.qty <= 0) throw badRequest('INVALID_QTY', 'Item quantity must be a positive integer.')

    return this.inTx(async (tx) => {
      const order = await this.requireOrder(tx, orderId)
      this.assertEditable(order.status)

      await this.insertItem(tx, orderId, input)
      await this.recompute(tx, orderId)
      return this.load(tx, orderId)
    })
  }

  /** Changes a line's quantity. OPEN only. */
  async changeItemQty(orderId: string, orderItemId: string, qty: number) {
    if (qty <= 0) throw badRequest('INVALID_QTY', 'Item quantity must be a positive integer.')

    return this.inTx(async (tx) => {
      const order = await this.requireOrder(tx, orderId)
      this.assertEditable(order.status)
      await this.requireItem(tx, orderId, orderItemId)

      await tx.orderItem.update({ where: { id: orderItemId }, data: { qty } })
      await this.recompute(tx, orderId)
      return this.load(tx, orderId)
    })
  }

  /** Removes a line while OPEN. Its item discounts cascade away with it. */
  async removeItem(orderId: string, orderItemId: string) {
    return this.inTx(async (tx) => {
      const order = await this.requireOrder(tx, orderId)
      this.assertEditable(order.status)
      await this.requireItem(tx, orderId, orderItemId)

      await tx.orderItem.delete({ where: { id: orderItemId } })
      await this.recompute(tx, orderId)
      return this.load(tx, orderId)
    })
  }

  /**
   * Fires the order to the kitchen/bar. OPEN → SENT.
   *
   * This is the snapshot moment (standard #7): price, name, and modifier deltas
   * freeze into the `*Snapshot` columns from the *current* master data, so later
   * edits to a variant or modifier never move this line.
   */
  async send(orderId: string) {
    const ctx = requireTenantContext()
    return this.inTx(async (tx) => {
      const order = await this.requireOrder(tx, orderId)
      this.assertTransition(order.status, 'SENT')

      const items = await tx.orderItem.findMany({
        where: { orderId },
        select: { id: true, variantId: true, modifiersSnapshot: true },
      })

      // Freeze prices through the one price seam — never re-resolved after this.
      const priceSvc = new PriceService(tx as unknown as BrewsyncClient)
      const variantIds = items.map((i) => i.variantId)
      const prices = await priceSvc.resolveMany(variantIds, {
        outletId: order.outletId,
        salesMethod: order.salesMethod,
      })
      const variants = await tx.productVariant.findMany({
        where: { id: { in: variantIds } },
        select: {
          id: true,
          name: true,
          fulfillmentType: true,
          product: {
            select: {
              fulfillmentType: true,
              // The category's declared station is a *name* hint: Category is
              // tenant-scoped while Station is outlet-owned, so the concrete
              // station is resolved per-outlet by name at SENT (design §5.5).
              category: { select: { defaultStation: { select: { name: true } } } },
            },
          },
        },
      })
      const nameById = new Map(variants.map((v) => [v.id, v.name]))
      const kdsEnabled = await new FeatureService(tx as unknown as BrewsyncClient).isEnabled('kds')

      // Resolve the category station hint to a concrete station in THIS outlet by
      // name. A hint with no same-named station here leaves the line unrouted
      // (still QUEUED, on the unrouted lane) rather than pointing at a foreign
      // outlet's station.
      const outletStations = kdsEnabled
        ? await tx.station.findMany({
            where: { outletId: order.outletId, isActive: true },
            select: { id: true, name: true },
          })
        : []
      const stationIdByName = new Map(outletStations.map((s) => [s.name, s.id]))

      // Effective fulfillment type (variant override ?? product default) + the
      // station resolved for this outlet, per variant, for the KDS routing decision.
      const routingByVariant = new Map(
        variants.map((v) => {
          const stationName = v.product.category?.defaultStation?.name ?? null
          return [
            v.id,
            {
              fulfillmentType: v.fulfillmentType ?? v.product.fulfillmentType,
              defaultStationId: stationName ? (stationIdByName.get(stationName) ?? null) : null,
            },
          ]
        })
      )

      // Refreeze modifier deltas from current master (freeze AT sent, not at add).
      const modMap = await this.loadModifiers(tx, items.flatMap((i) => this.readModifierIds(i.modifiersSnapshot)))

      let routedCount = 0
      for (const item of items) {
        const ids = this.readModifierIds(item.modifiersSnapshot)
        const chosen = ids.map((id) => modMap.get(id)).filter((m): m is NonNullable<typeof m> => m != null)
        const delta = chosen.reduce((acc, m) => acc + m.priceDelta, 0n)
        const snapshot: ModifierSnapshotEntry[] = chosen.map((m) => ({
          modifierId: m.id,
          name: m.name,
          priceDelta: m.priceDelta.toString(),
        }))

        // Route to a KDS station (§5.5) — pure decision, applied here.
        const routing = routeLine(kdsEnabled, routingByVariant.get(item.variantId)!)
        if (routing.kdsStatus !== null) routedCount += 1

        await tx.orderItem.update({
          where: { id: item.id },
          data: {
            priceSnapshot: prices.get(item.variantId)?.price ?? 0n,
            nameSnapshot: nameById.get(item.variantId) ?? '',
            modifierDeltaSnapshot: delta,
            modifiersSnapshot: snapshot as unknown as Prisma.InputJsonValue,
            stationId: routing.stationId,
            kdsStatus: routing.kdsStatus,
          },
        })
      }

      await tx.order.update({
        where: { id: orderId },
        data: { status: 'SENT', sentAt: new Date() },
      })

      // Stock deduction at SENT (§4.2) — a no-op unless the outlet deducts at
      // SENT. Idempotent on ('order', orderId), so a redelivered send is safe.
      await new StockDeductionService(tx as unknown as BrewsyncClient).deductForOrder(
        tx,
        {
          id: orderId,
          outletId: order.outletId,
          items: await tx.orderItem.findMany({
            where: { orderId },
            select: { variantId: true, qty: true },
          }),
        },
        'SENT',
        ctx.userId ?? null
      )

      // Tell the kitchen board new tickets landed (S7-05) — only when something
      // actually routed, so a pure-STOCKED order does not wake idle screens.
      if (routedCount > 0) {
        await emitEvent(tx as unknown as OutboxCapableTx, {
          tenantId: ctx.tenantId,
          outletId: order.outletId,
          type: EVENT_TYPES.ORDER_SENT,
          payload: { orderId, routedCount },
        })
      }

      await this.recompute(tx, orderId)
      return this.load(tx, orderId)
    })
  }

  /** Marks a sent order delivered. SENT → SERVED. Pure bookkeeping; charges unaffected. */
  async markServed(orderId: string) {
    return this.inTx(async (tx) => {
      const order = await this.requireOrder(tx, orderId)
      this.assertTransition(order.status, 'SERVED')
      await tx.order.update({ where: { id: orderId }, data: { status: 'SERVED' } })
      return this.load(tx, orderId)
    })
  }

  /** Applies a discount to one line (§6.4). Persisted as a DISCOUNT row carrying its target line. */
  async applyItemDiscount(orderId: string, orderItemId: string, input: DiscountInput) {
    this.assertDiscountShape(input)
    return this.inTx(async (tx) => {
      const order = await this.requireOrder(tx, orderId)
      this.assertPreBilled(order.status)
      await this.requireItem(tx, orderId, orderItemId)

      await this.seedDiscount(tx, orderId, input, orderItemId)
      await this.recompute(tx, orderId)
      return this.load(tx, orderId)
    })
  }

  /** Applies an order-level discount (§6.4), against the running discounted subtotal. */
  async applyOrderDiscount(orderId: string, input: DiscountInput) {
    this.assertDiscountShape(input)
    return this.inTx(async (tx) => {
      const order = await this.requireOrder(tx, orderId)
      this.assertPreBilled(order.status)

      await this.seedDiscount(tx, orderId, input, null)
      await this.recompute(tx, orderId)
      return this.load(tx, orderId)
    })
  }

  /** Sets (or clears, with 0) the gratuity — outside the total, never taxed (§6 step 7). */
  async setGratuity(orderId: string, gratuityMinor: bigint) {
    if (gratuityMinor < 0n) throw badRequest('INVALID_GRATUITY', 'Gratuity cannot be negative.')
    return this.inTx(async (tx) => {
      const order = await this.requireOrder(tx, orderId)
      this.assertPreBilled(order.status)

      await tx.orderCharge.deleteMany({ where: { orderId, kind: 'GRATUITY' } })
      if (gratuityMinor > 0n) {
        await tx.orderCharge.create({
          data: {
            orderId,
            kind: 'GRATUITY',
            label: 'Gratuity',
            basis: gratuityMinor,
            rateBp: null,
            amount: gratuityMinor,
            taxable: false,
            sortOrder: 0,
          } as unknown as Prisma.OrderChargeCreateInput,
        })
      }
      await this.recompute(tx, orderId)
      return this.load(tx, orderId)
    })
  }

  /**
   * Raises the bill. SENT/SERVED → BILLED.
   *
   * One final recompute produces the authoritative charge rows, then the status
   * flips — after which no mutation recomputes, so those rows are frozen (§7.1).
   * The same moment snapshots the money into a single `Bill` (seq 1): its `total`
   * is `amountDue` (the §6 total plus gratuity — what the customer actually
   * hands over), so a later master-data edit never shifts this bill (standard
   * #7). Splitting into several bills is a separate S5 operation on top of this
   * one; the single bill here satisfies SUM(bill.total) === order total trivially.
   *
   * Emits nothing: SaleCompleted is emitted at PAID by the payment path.
   */
  async bill(orderId: string) {
    return this.inTx(async (tx) => {
      const order = await this.requireOrder(tx, orderId)
      this.assertTransition(order.status, 'BILLED')

      await this.recompute(tx, orderId)
      const summary = await this.computeSummary(tx, orderId)
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'BILLED', billedAt: new Date() },
      })

      // Idempotent on re-bill (the machine forbids re-entering BILLED, so this
      // only ever inserts once): the single snapshot bill for the whole order.
      await tx.bill.create({
        data: {
          orderId,
          seq: 1,
          subtotal: summary.subtotal,
          total: summary.amountDue,
        } as unknown as Prisma.BillCreateInput,
      })
      return this.load(tx, orderId)
    })
  }

  /**
   * Voids the whole order. Reachable from every pre-PAID state (a mistake can
   * always be undone before money is taken). Emits ORDER_VOIDED in the same
   * transaction (standard #4).
   */
  async void(orderId: string) {
    const ctx = requireTenantContext()
    return this.inTx(async (tx) => {
      const order = await this.requireOrder(tx, orderId)
      this.assertTransition(order.status, 'VOID')

      await tx.order.update({ where: { id: orderId }, data: { status: 'VOID' } })
      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: order.outletId,
        type: EVENT_TYPES.ORDER_VOIDED,
        payload: { orderId, previousStatus: order.status },
      })
      return this.load(tx, orderId)
    })
  }

  /**
   * Voids a single line — the post-SENT correction path (`removeItem` is OPEN
   * only). Removing the row loses no history: the snapshot is emitted to the
   * outbox as ITEM_VOIDED before deletion. Legal while pre-BILLED.
   */
  async voidItem(orderId: string, orderItemId: string) {
    const ctx = requireTenantContext()
    return this.inTx(async (tx) => {
      const order = await this.requireOrder(tx, orderId)
      this.assertPreBilled(order.status)

      const item = await tx.orderItem.findUnique({
        where: { id: orderItemId },
        select: { id: true, orderId: true, variantId: true, qty: true, nameSnapshot: true },
      })
      if (!item || item.orderId !== orderId) {
        throw notFound('ORDER_ITEM_NOT_FOUND', `Order item ${orderItemId} not found on order ${orderId}.`)
      }

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: order.outletId,
        type: EVENT_TYPES.ITEM_VOIDED,
        payload: {
          orderId,
          orderItemId,
          variantId: item.variantId,
          qty: item.qty,
          nameSnapshot: item.nameSnapshot,
        },
      })

      await tx.orderItem.delete({ where: { id: orderItemId } })
      await this.recompute(tx, orderId)
      return this.load(tx, orderId)
    })
  }

  /**
   * Transfers an order to a different table (§5.4). Moves `tableId`, seats the
   * target (→ OCCUPIED) and frees the source (→ DIRTY). Legal for any order that
   * still holds a table (pre-PAID); touches no money, so no recompute. The
   * partial unique index `orders_one_per_table` is the backstop against seating a
   * table that already has an active order — a P2002 there surfaces as 409.
   */
  async transfer(orderId: string, targetTableId: string) {
    const ctx = requireTenantContext()
    return this.inTx(async (tx) => {
      const order = await this.requireOrder(tx, orderId)
      if (!ORDER_ON_FLOOR.has(order.status)) {
        throw conflict('ORDER_NOT_ON_FLOOR', `Order is ${order.status}; it no longer holds a table.`)
      }
      if (order.tableId === targetTableId) return this.load(tx, orderId)

      const target = await this.requireTable(tx, targetTableId)
      if (target.outletId !== order.outletId) {
        throw badRequest('TABLE_WRONG_OUTLET', 'The target table belongs to another outlet.')
      }

      const sourceTableId = order.tableId
      await this.seatTable(tx, target)
      try {
        await tx.order.update({ where: { id: orderId }, data: { tableId: targetTableId } })
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw conflict('TABLE_OCCUPIED', 'That table already has an active order.')
        }
        throw err
      }
      await this.freeTable(tx, sourceTableId)

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: order.outletId,
        type: EVENT_TYPES.ORDER_TRANSFERRED,
        payload: { orderId, fromTableId: sourceTableId, toTableId: targetTableId },
      })
      return this.load(tx, orderId)
    })
  }

  /**
   * Merges the `absorbedOrderId` into the `survivorOrderId` (§5.4): the absorbed
   * order's items (and their item-level discounts) move to the survivor, the
   * absorbed order is VOIDed and its table freed. Per the approved policy, the
   * absorbed order's ORDER-level discount and gratuity are DROPPED — their basis
   * (the vanished subtotal/total) no longer applies — and returned as warnings so
   * the UI can tell the cashier.
   *
   * Both orders must be pre-BILLED (charges are working state) and on the same
   * side of the SENT boundary (standard #7): mixing a live-priced OPEN order with
   * a snapshot-frozen SENT order would let the survivor's pricing regime silently
   * re-price the moved lines. Same outlet, and not the same order.
   */
  async merge(survivorOrderId: string, absorbedOrderId: string) {
    const ctx = requireTenantContext()
    if (survivorOrderId === absorbedOrderId) {
      throw badRequest('MERGE_SELF', 'An order cannot be merged into itself.')
    }
    return this.inTx(async (tx) => {
      const survivor = await this.requireOrder(tx, survivorOrderId)
      const absorbed = await this.requireOrder(tx, absorbedOrderId)
      this.assertPreBilled(survivor.status)
      this.assertPreBilled(absorbed.status)
      this.assertSameOutlet(survivor, absorbed)
      this.assertSamePricingEpoch(survivor, absorbed)

      // Classify the absorbed order's charges: item discounts travel, order
      // discount + gratuity are dropped (with warnings), derived rows recomputed.
      const absorbedCharges = await tx.orderCharge.findMany({
        where: { orderId: absorbedOrderId },
        select: { kind: true, label: true, amount: true, orderItemId: true },
      })
      const { itemDiscountIds, warnings } = classifyMergeCharges(
        absorbedCharges.map((c) => ({
          kind: c.kind as 'DISCOUNT' | 'SERVICE_CHARGE' | 'TAX' | 'ROUNDING' | 'GRATUITY',
          label: c.label,
          amount: c.amount.toString(),
          orderItemId: c.orderItemId,
        }))
      )

      // Move items to the survivor. Their snapshots (frozen or empty) travel with
      // them unchanged; the same-epoch guard keeps recompute consistent.
      const movedItems = await tx.orderItem.findMany({
        where: { orderId: absorbedOrderId },
        select: { id: true },
      })
      await tx.orderItem.updateMany({
        where: { orderId: absorbedOrderId },
        data: { orderId: survivorOrderId } as unknown as Prisma.OrderItemUpdateManyMutationInput,
      })
      // Reparent the surviving item discounts (order-level rows are left to be
      // deleted with the absorbed order below).
      if (itemDiscountIds.length > 0) {
        await tx.orderCharge.updateMany({
          where: { orderId: absorbedOrderId, orderItemId: { in: itemDiscountIds } },
          data: { orderId: survivorOrderId } as unknown as Prisma.OrderChargeUpdateManyMutationInput,
        })
      }
      // The absorbed order's remaining charges (order discount, gratuity, derived)
      // are dropped; delete them before voiding.
      await tx.orderCharge.deleteMany({ where: { orderId: absorbedOrderId } })

      // Void the now-empty absorbed order and free its table.
      this.assertTransition(absorbed.status, 'VOID')
      await tx.order.update({
        where: { id: absorbedOrderId },
        data: { status: 'VOID', tableId: null },
      })
      await this.freeTable(tx, absorbed.tableId)

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: survivor.outletId,
        type: EVENT_TYPES.ORDER_MERGED,
        payload: {
          survivorOrderId,
          absorbedOrderId,
          movedItemCount: movedItems.length,
          droppedCharges: warnings,
        },
      })

      await this.recompute(tx, survivorOrderId)
      const order = await this.load(tx, survivorOrderId)
      return { order, warnings }
    })
  }

  /**
   * Moves a subset of items from one order to another (§5.4) — e.g. splitting a
   * table's shared line onto a separate bill. Item-level discounts travel with
   * their line; order-level charges on either side recompute against the new
   * subtotals. Both orders must be pre-BILLED, same outlet, same pricing epoch.
   * The source order is left as-is even if it ends up empty (the cashier decides
   * whether to void it).
   */
  async moveItems(fromOrderId: string, toOrderId: string, orderItemIds: string[]) {
    const ctx = requireTenantContext()
    if (fromOrderId === toOrderId) {
      throw badRequest('MOVE_SELF', 'Source and target orders must differ.')
    }
    if (orderItemIds.length === 0) {
      throw badRequest('MOVE_EMPTY', 'Select at least one item to move.')
    }
    return this.inTx(async (tx) => {
      const from = await this.requireOrder(tx, fromOrderId)
      const to = await this.requireOrder(tx, toOrderId)
      this.assertPreBilled(from.status)
      this.assertPreBilled(to.status)
      this.assertSameOutlet(from, to)
      this.assertSamePricingEpoch(from, to)

      // Every id must belong to the source order.
      const items = await tx.orderItem.findMany({
        where: { id: { in: orderItemIds }, orderId: fromOrderId },
        select: { id: true },
      })
      if (items.length !== orderItemIds.length) {
        throw notFound('ORDER_ITEM_NOT_FOUND', 'One or more items do not belong to the source order.')
      }

      await tx.orderItem.updateMany({
        where: { id: { in: orderItemIds }, orderId: fromOrderId },
        data: { orderId: toOrderId } as unknown as Prisma.OrderItemUpdateManyMutationInput,
      })
      // Item discounts follow their line.
      await tx.orderCharge.updateMany({
        where: { orderId: fromOrderId, orderItemId: { in: orderItemIds } },
        data: { orderId: toOrderId } as unknown as Prisma.OrderChargeUpdateManyMutationInput,
      })

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: from.outletId,
        type: EVENT_TYPES.ITEMS_MOVED,
        payload: { fromOrderId, toOrderId, orderItemIds },
      })

      await this.recompute(tx, fromOrderId)
      await this.recompute(tx, toOrderId)
      return {
        from: await this.load(tx, fromOrderId),
        to: await this.load(tx, toOrderId),
      }
    })
  }

  /** Reads one order with its lines and charge breakdown. */
  async getById(orderId: string) {
    const order = await this.load(this.db as unknown as Tx, orderId)
    if (!order) throw notFound('ORDER_NOT_FOUND', `Order ${orderId} not found.`)
    return order
  }

  /** Lists orders for an outlet, newest first. */
  async list(opts: { outletId?: string; status?: OrderStatus } = {}) {
    return this.db.order.findMany({
      where: {
        ...(opts.outletId ? { outletId: opts.outletId } : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
      include: { items: true, charges: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    })
  }

  /* ---------------------------------------------------------------- internals */

  /** Wraps work in an RLS-bound transaction. All delegate calls inside use `tx`. */
  private inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.db as unknown as PrismaClient, fn)
  }

  /**
   * The one place charges are rebuilt (delete-then-insert). Reconstructs the
   * pipeline inputs from the durable DISCOUNT/GRATUITY rows, runs the pure
   * pipeline, then rewrites the full breakdown. Never called after BILLED.
   */
  private async recompute(tx: Tx, orderId: string): Promise<void> {
    const { pipelineInput, items, itemDiscounts } = await this.gatherPipeline(tx, orderId)
    const result = runBillPipeline(pipelineInput)

    // Re-associate item discounts to their line. The pipeline emits item
    // discounts (in input order) before order discounts, so the k-th DISCOUNT
    // row is itemDiscounts[k] while k < itemDiscounts.length.
    let discountSeen = 0
    const rows = result.charges.map((ch) => {
      let attachedItemId: string | null = null
      if (ch.kind === 'DISCOUNT') {
        if (discountSeen < itemDiscounts.length) {
          attachedItemId = items[itemDiscounts[discountSeen]!.lineIndex]!.id
        }
        discountSeen += 1
      }
      return {
        orderId,
        orderItemId: attachedItemId,
        kind: ch.kind,
        label: ch.label,
        basis: ch.basis as bigint,
        rateBp: ch.rateBp,
        amount: ch.amount as bigint,
        taxable: ch.taxable,
        sortOrder: ch.sortOrder,
      }
    })

    await tx.orderCharge.deleteMany({ where: { orderId } })
    if (rows.length > 0) {
      await tx.orderCharge.createMany({
        data: rows as unknown as Prisma.OrderChargeCreateManyInput[],
      })
    }
  }

  /**
   * Assembles the pure pipeline inputs from persisted state — the single seam
   * shared by the write path (`recompute`, which rewrites the charge rows) and
   * the read path (`computeSummary`, which derives the summary for `load`).
   * Keeping it in one place is what guarantees the total a client is shown is the
   * total that gets persisted: both run identical inputs through the same pipeline.
   *
   * Line prices are live through `PriceService` while OPEN (sentAt null) and read
   * from the frozen `priceSnapshot` after SENT (standard #7). Discounts and
   * gratuity are reconstructed from their durable `OrderCharge` rows.
   */
  private async gatherPipeline(
    client: Tx,
    orderId: string
  ): Promise<{
    pipelineInput: PipelineInput
    items: { id: string; unitPriceMinor: bigint; lineSubtotalMinor: bigint }[]
    itemDiscounts: ItemDiscountInput[]
  }> {
    const order = await client.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { outletId: true, salesMethod: true, sentAt: true },
    })
    const items = await client.orderItem.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        variantId: true,
        qty: true,
        priceSnapshot: true,
        modifierDeltaSnapshot: true,
      },
    })
    const existing = await client.orderCharge.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { kind: true, label: true, rateBp: true, amount: true, orderItemId: true },
    })

    // Step 1 inputs — unit price then line subtotal. Live price while OPEN;
    // frozen snapshot after SENT. `unitPriceMinor` includes the modifier delta so
    // the FE can show a meaningful per-line price without any money math.
    let unitPriceOf: (item: (typeof items)[number]) => bigint
    if (order.sentAt === null) {
      const priceSvc = new PriceService(client as unknown as BrewsyncClient)
      const prices = await priceSvc.resolveMany(items.map((i) => i.variantId), {
        outletId: order.outletId,
        salesMethod: order.salesMethod,
      })
      unitPriceOf = (i) => prices.get(i.variantId)!.price + i.modifierDeltaSnapshot
    } else {
      unitPriceOf = (i) => i.priceSnapshot + i.modifierDeltaSnapshot
    }

    const priced = items.map((i) => {
      const unitPriceMinor = unitPriceOf(i)
      return {
        id: i.id,
        unitPriceMinor,
        lineSubtotalMinor: unitPriceMinor * BigInt(i.qty),
      }
    })
    const lines: PipelineLine[] = priced.map((p) => ({ subtotalMinor: p.lineSubtotalMinor }))

    // Reconstruct discounts from the durable DISCOUNT rows, preserving apply order.
    const indexById = new Map(items.map((it, idx) => [it.id, idx]))
    const itemDiscounts: ItemDiscountInput[] = []
    const orderDiscounts: DiscountInput[] = []
    for (const c of existing) {
      if (c.kind !== 'DISCOUNT') continue
      const magnitude = c.amount < 0n ? -c.amount : c.amount
      const base: DiscountInput =
        c.rateBp !== null ? { label: c.label, rateBp: c.rateBp } : { label: c.label, amountMinor: magnitude }
      if (c.orderItemId !== null) {
        const lineIndex = indexById.get(c.orderItemId)
        if (lineIndex === undefined) continue // line gone; discount is moot
        itemDiscounts.push({ ...base, lineIndex })
      } else {
        orderDiscounts.push(base)
      }
    }

    const gratuityRow = existing.find((c) => c.kind === 'GRATUITY')
    const gratuityMinor = gratuityRow ? (gratuityRow.amount < 0n ? -gratuityRow.amount : gratuityRow.amount) : 0n

    const outlet = await client.outlet.findUniqueOrThrow({
      where: { id: order.outletId },
      select: {
        taxInclusive: true,
        taxRateBp: true,
        serviceChargeRateBp: true,
        roundingIncrement: true,
      },
    })
    const fiscal: FiscalConfig = {
      taxInclusive: outlet.taxInclusive,
      taxRateBp: outlet.taxRateBp,
      serviceChargeRateBp: outlet.serviceChargeRateBp,
      roundingIncrement: outlet.roundingIncrement,
    }

    return {
      pipelineInput: { lines, fiscal, itemDiscounts, orderDiscounts, gratuityMinor },
      items: priced,
      itemDiscounts,
    }
  }

  /** Persists a durable discount seed; `recompute` canonicalizes it. */
  private async seedDiscount(
    tx: Tx,
    orderId: string,
    input: DiscountInput,
    orderItemId: string | null
  ): Promise<void> {
    // For a fixed discount, store the magnitude as a negative amount so a rewrite
    // can read it back; for a percent discount, the rateBp is the source of truth
    // and amount is a placeholder recompute overwrites.
    const seedAmount = input.amountMinor !== undefined ? -input.amountMinor : 0n
    await tx.orderCharge.create({
      data: {
        orderId,
        orderItemId,
        kind: 'DISCOUNT',
        label: input.label,
        basis: 0n,
        rateBp: input.rateBp ?? null,
        amount: seedAmount,
        taxable: true,
        sortOrder: 0,
      } as unknown as Prisma.OrderChargeCreateInput,
    })
  }

  /** Resolves modifier ids to their current master rows, keyed by id. */
  private async loadModifiers(tx: Tx, modifierIds: string[]) {
    const unique = [...new Set(modifierIds)]
    if (unique.length === 0) return new Map<string, { id: string; name: string; priceDelta: bigint }>()
    const rows = await tx.modifier.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true, priceDelta: true },
    })
    return new Map(rows.map((m) => [m.id, m]))
  }

  /** Inserts one line with its working modifier selection resolved now. */
  private async insertItem(tx: Tx, orderId: string, input: OrderItemInput): Promise<void> {
    const variant = await tx.productVariant.findUnique({
      where: { id: input.variantId },
      select: { id: true },
    })
    if (!variant) throw notFound('VARIANT_NOT_FOUND', `Variant ${input.variantId} not found.`)

    const modMap = await this.loadModifiers(tx, input.modifierIds ?? [])
    const chosen = (input.modifierIds ?? [])
      .map((id) => modMap.get(id))
      .filter((m): m is NonNullable<typeof m> => m != null)
    if (chosen.length !== (input.modifierIds ?? []).length) {
      throw badRequest('MODIFIER_NOT_FOUND', 'One or more chosen modifiers do not exist.')
    }

    const delta = chosen.reduce((acc, m) => acc + m.priceDelta, 0n)
    const snapshot: ModifierSnapshotEntry[] = chosen.map((m) => ({
      modifierId: m.id,
      name: m.name,
      priceDelta: m.priceDelta.toString(),
    }))

    await tx.orderItem.create({
      data: {
        orderId,
        variantId: input.variantId,
        qty: input.qty,
        modifierDeltaSnapshot: delta,
        modifiersSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      } as unknown as Prisma.OrderItemCreateInput,
    })
  }

  /** Reads modifier ids out of a stored `modifiersSnapshot` JSON value. */
  private readModifierIds(json: Prisma.JsonValue | null): string[] {
    if (!Array.isArray(json)) return []
    return json
      .map((e) => (e && typeof e === 'object' && 'modifierId' in e ? (e as { modifierId: unknown }).modifierId : null))
      .filter((id): id is string => typeof id === 'string')
  }

  /**
   * Reads one order with its lines, charge breakdown, and a derived money
   * summary.
   *
   * The persisted rows carry the *breakdown* but not a subtotal/total, and while
   * OPEN a line's `priceSnapshot` is still zero (it freezes at SENT). The cashier
   * screen nonetheless needs a running total and per-line prices as it builds the
   * order. So `load` re-runs the same pure pipeline on read (`computeSummary`) —
   * deterministic on frozen inputs post-SENT, live-priced while OPEN — and folds
   * `unitPrice`/`lineSubtotal` onto each item plus a `summary`. Every amount stays
   * a BigInt, so the money never becomes a float and the wire carries decimal
   * strings (standard #2). The FE renders these rows; it does no money math.
   */
  private async load(client: Tx, orderId: string) {
    const order = await client.order.findUnique({
      where: { id: orderId },
      include: {
        items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        charges: { orderBy: { sortOrder: 'asc' } },
        bills: {
          orderBy: { seq: 'asc' },
          include: { payments: { orderBy: { createdAt: 'asc' } } },
        },
      },
    })
    if (!order) return null

    const summary = await this.computeSummary(client, orderId)
    const priceByItem = new Map(summary.lines.map((l) => [l.id, l]))
    return {
      ...order,
      items: order.items.map((item) => {
        const line = priceByItem.get(item.id)
        return {
          ...item,
          unitPrice: line?.unitPriceMinor ?? 0n,
          lineSubtotal: line?.lineSubtotalMinor ?? 0n,
        }
      }),
      summary: {
        subtotal: summary.subtotal,
        total: summary.total,
        amountDue: summary.amountDue,
        taxContributesToTotal: summary.taxContributesToTotal,
      },
    }
  }

  /**
   * Runs the pipeline as a pure read — no charge rewrite — to derive the
   * subtotal/total/amountDue and per-line display prices for `load`. Shares
   * `gatherPipeline` with `recompute`, so the numbers a client sees are computed
   * by exactly the same code that persists the charges: they cannot drift.
   */
  private async computeSummary(client: Tx, orderId: string) {
    const gathered = await this.gatherPipeline(client, orderId)
    const result = runBillPipeline(gathered.pipelineInput)
    return {
      lines: gathered.items,
      subtotal: result.subtotal as bigint,
      total: result.total as bigint,
      amountDue: result.amountDue as bigint,
      taxContributesToTotal: result.taxContributesToTotal,
    }
  }

  private async requireOrder(tx: Tx, orderId: string) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        outletId: true,
        salesMethod: true,
        tableId: true,
        sentAt: true,
      },
    })
    if (!order) throw notFound('ORDER_NOT_FOUND', `Order ${orderId} not found.`)
    return { ...order, status: order.status as OrderStatus }
  }

  /** Loads a table and asserts it exists (floor operations, §5.4). */
  private async requireTable(tx: Tx, tableId: string) {
    const table = await tx.table.findUnique({
      where: { id: tableId },
      select: { id: true, outletId: true, status: true, isActive: true },
    })
    if (!table) throw notFound('TABLE_NOT_FOUND', `Table ${tableId} not found.`)
    return { ...table, status: table.status as TableStatus }
  }

  /**
   * Frees a table an order is leaving: OCCUPIED → DIRTY (needs bussing before
   * reseat, §5.4). Silently skips a table that is not currently OCCUPIED, so a
   * double transfer or a race cannot throw an illegal-transition here.
   */
  private async freeTable(tx: Tx, tableId: string | null): Promise<void> {
    if (!tableId) return
    const table = await this.requireTable(tx, tableId)
    if (table.status === 'OCCUPIED') {
      await tx.table.update({ where: { id: tableId }, data: { status: 'DIRTY' } })
    }
  }

  /** Seats an order at a table: asserts the table can take it, flips it OCCUPIED. */
  private async seatTable(tx: Tx, table: { id: string; status: TableStatus }): Promise<void> {
    try {
      tableStateMachine.assert(table.status, 'OCCUPIED')
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        throw conflict('TABLE_NOT_AVAILABLE', `Table is ${table.status}; it cannot be seated.`)
      }
      throw err
    }
    await tx.table.update({ where: { id: table.id }, data: { status: 'OCCUPIED' } })
  }

  private async requireItem(tx: Tx, orderId: string, orderItemId: string): Promise<void> {
    const item = await tx.orderItem.findUnique({
      where: { id: orderItemId },
      select: { id: true, orderId: true },
    })
    if (!item || item.orderId !== orderId) {
      throw notFound('ORDER_ITEM_NOT_FOUND', `Order item ${orderItemId} not found on order ${orderId}.`)
    }
  }

  private async requireOutlet(tx: Tx, outletId: string): Promise<void> {
    const outlet = await tx.outlet.findUnique({ where: { id: outletId }, select: { id: true } })
    if (!outlet) throw notFound('OUTLET_NOT_FOUND', `Outlet ${outletId} not found.`)
  }

  private assertEditable(status: OrderStatus): void {
    if (!isEditable(status)) {
      throw conflict('ORDER_NOT_EDITABLE', `Order is ${status}; items can only be changed while OPEN.`)
    }
  }

  private assertPreBilled(status: OrderStatus): void {
    if (!PRE_BILLED.has(status)) {
      throw conflict('ORDER_FROZEN', `Order is ${status}; charges are frozen once BILLED.`)
    }
  }

  /** Both orders in a merge / move must live in the same outlet (§5.4). */
  private assertSameOutlet(a: { outletId: string }, b: { outletId: string }): void {
    if (a.outletId !== b.outletId) {
      throw badRequest('CROSS_OUTLET', 'Both orders must belong to the same outlet.')
    }
  }

  /**
   * Both orders must be on the same side of the SENT snapshot boundary (standard
   * #7). Moving a line between a live-priced order (sentAt null) and a
   * snapshot-frozen one would let the target's pricing regime silently re-price
   * it. `gatherPipeline` keys its live/frozen decision on the *order's* sentAt, so
   * the invariant is one epoch per order — enforce it before any item moves.
   */
  private assertSamePricingEpoch(
    a: { sentAt: Date | null },
    b: { sentAt: Date | null }
  ): void {
    if ((a.sentAt === null) !== (b.sentAt === null)) {
      throw conflict(
        'PRICING_EPOCH_MISMATCH',
        'One order is still open (live-priced) and the other is sent (frozen); they cannot be combined.'
      )
    }
  }

  /** True for a Prisma P2002 unique-constraint violation (e.g. one-order-per-table). */
  private isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
  }

  /** Asserts a transition, translating the machine's error to HTTP 409. */
  private assertTransition(from: OrderStatus, to: OrderStatus): void {
    try {
      orderStateMachine.assert(from, to)
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        throw conflict('ILLEGAL_TRANSITION', err.message)
      }
      throw err
    }
  }

  private assertDiscountShape(input: DiscountInput): void {
    const hasRate = input.rateBp !== undefined
    const hasAmount = input.amountMinor !== undefined
    if (hasRate === hasAmount) {
      throw badRequest(
        'INVALID_DISCOUNT',
        'A discount must set exactly one of a percent (rateBp) or a fixed amount (amountMinor).'
      )
    }
    if (hasRate && input.rateBp! < 0) {
      throw badRequest('INVALID_DISCOUNT', 'Discount percent cannot be negative.')
    }
    if (hasAmount && input.amountMinor! < 0n) {
      throw badRequest('INVALID_DISCOUNT', 'Discount amount cannot be negative.')
    }
  }
}
