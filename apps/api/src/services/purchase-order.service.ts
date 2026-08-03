/**
 * PurchaseOrder service — S6-06, design §4.5 (standards #1, #2, #6, #7).
 *
 * Orchestrates the PO lifecycle. It owns no transition truth (that is
 * `purchase-order.state.ts`) and does the money math through the shared minor-unit
 * helpers (`extendedCost` / `Money`), never a float (standard #2). Tenant scoping
 * is the Prisma extension's job (standard #1): no `where: { tenantId }` here.
 *
 * Drafting/approval never touch stock. The goods receipt (S6-07/08, `receive`)
 * is the ONE place a PO moves inventory: it appends a `StockMovement type=PURCHASE`
 * per received line (standard #3 — the movement rows are the receipt record, there
 * is no separate GoodsReceipt entity) with `costPerUnit = unitCost`, accumulates
 * `qtyReceivedScaled` on the line, drives APPROVED → RECEIVING (partial) / RECEIVED
 * (fully received), and emits `GoodsReceived` for Accounting (standard #4). The
 * CLOSED edge is declared in the machine but driven later (matching, S6+).
 *
 * Two timing rules, both from the design:
 *
 *   1. DRAFT is the only editable state (§4.5). `create`/`updateDraft` replace the
 *      whole line set; every other verb refuses to touch lines.
 *
 *   2. APPROVED is the snapshot moment (standard #7). `unitCost` and qty freeze,
 *      `lineTotal = extendedCost(qty, unitCost)` and the header
 *      `subtotal/taxAmount/total` are computed once and persisted. Nothing is
 *      re-read from master data after — editing a supplier or a price later never
 *      shifts an approved PO. `PurchaseOrderApproved` is emitted in the same
 *      transaction (standard #4).
 *
 * `poNumber` is the human-facing per-tenant number: assigned as `MAX(poNumber)+1`
 * inside the create transaction and guarded by the `@@unique([tenantId, poNumber])`
 * index, which turns a concurrent-create collision into a single retry.
 *
 * Illegal transitions throw `IllegalTransitionError`, translated to HTTP 409 here.
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
import { IllegalTransitionError, EVENT_TYPES, Money, extendedCost } from '@brewsync/shared'
import { badRequest, conflict, notFound } from '../http-error.js'
import {
  purchaseOrderStateMachine,
  isEditable,
  type PurchaseOrderStatus,
} from './purchase-order.state.js'
import { StockService } from './stock.service.js'

type Tx = Prisma.TransactionClient

export interface PurchaseOrderLineInput {
  variantId: string
  /** Scaled base units (UNIT_FACTOR_SCALE), the same scale StockMovement uses. */
  qtyOrderedScaled: bigint
  /** Minor units per one base unit. Frozen at APPROVED. */
  unitCost?: bigint
  sortOrder?: number
}

export interface CreatePurchaseOrderInput {
  outletId: string
  supplierId: string
  expectedDate?: Date | null
  /** Basis points (1100 = 11%). Snapshotted into the header totals at APPROVED. */
  taxRateBp?: number
  notes?: string | null
  items: PurchaseOrderLineInput[]
}

export interface UpdatePurchaseOrderDraftInput {
  expectedDate?: Date | null
  taxRateBp?: number
  notes?: string | null
  items?: PurchaseOrderLineInput[]
}

/** One line of a goods receipt: how much of a PO line physically arrived. */
export interface ReceiveLineInput {
  /** The `PurchaseOrderItem.id` being received against. */
  poItemId: string
  /** Quantity received now, scaled base units. Must be > 0 and ≤ outstanding. */
  qtyScaled: bigint
}

export interface ReceivePurchaseOrderInput {
  lines: ReceiveLineInput[]
}

/** A folded set of line totals plus the header money, minor units. */
interface Totals {
  lineTotals: bigint[]
  subtotal: bigint
  taxAmount: bigint
  total: bigint
}

export class PurchaseOrderService {
  private readonly stock: StockService

  constructor(private readonly db: BrewsyncClient) {
    this.stock = new StockService(db)
  }

  /**
   * Opens a PO in DRAFT with its lines. Assigns the per-tenant `poNumber` as
   * MAX+1; a concurrent create that collides on the unique index is retried once.
   */
  async create(input: CreatePurchaseOrderInput) {
    this.assertLines(input.items)
    const taxRateBp = this.assertTaxRate(input.taxRateBp)

    return this.inTx(async (tx) => {
      await this.requireOutlet(tx, input.outletId)
      await this.requireSupplier(tx, input.supplierId)
      await this.requireVariants(tx, input.items.map((i) => i.variantId))

      const poId = await this.createWithNumber(tx, input, taxRateBp)
      await this.replaceLines(tx, poId, input.items)
      return this.load(tx, poId)
    })
  }

  /** Reads one PO with its lines and a derived money summary. */
  async getById(poId: string) {
    const po = await this.load(this.db as unknown as Tx, poId)
    if (!po) throw notFound('PURCHASE_ORDER_NOT_FOUND', `Purchase order ${poId} not found.`)
    return po
  }

  /** Lists POs for an outlet (or the whole tenant), newest first. */
  async list(opts: { outletId?: string; supplierId?: string; status?: PurchaseOrderStatus } = {}) {
    return this.db.purchaseOrder.findMany({
      where: {
        ...(opts.outletId ? { outletId: opts.outletId } : {}),
        ...(opts.supplierId ? { supplierId: opts.supplierId } : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
      include: { items: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
      orderBy: { poNumber: 'desc' },
    })
  }

  /** Replaces the header fields and/or the whole line set. DRAFT only (§4.5). */
  async updateDraft(poId: string, input: UpdatePurchaseOrderDraftInput) {
    const taxRateBp = input.taxRateBp !== undefined ? this.assertTaxRate(input.taxRateBp) : undefined
    if (input.items !== undefined) this.assertLines(input.items)

    return this.inTx(async (tx) => {
      const po = await this.requirePo(tx, poId)
      this.assertEditable(po.status)

      if (input.items !== undefined) {
        await this.requireVariants(tx, input.items.map((i) => i.variantId))
      }

      await tx.purchaseOrder.update({
        where: { id: poId },
        data: {
          ...(input.expectedDate !== undefined ? { expectedDate: input.expectedDate } : {}),
          ...(taxRateBp !== undefined ? { taxRateBp } : {}),
          ...(input.notes !== undefined ? { notes: this.orNull(input.notes) } : {}),
        },
      })

      if (input.items !== undefined) {
        await this.replaceLines(tx, poId, input.items)
      }
      return this.load(tx, poId)
    })
  }

  /** Submits a draft for approval. DRAFT → SUBMITTED. */
  async submit(poId: string) {
    return this.inTx(async (tx) => {
      const po = await this.requirePo(tx, poId)
      this.assertTransition(po.status, 'SUBMITTED')
      await tx.purchaseOrder.update({ where: { id: poId }, data: { status: 'SUBMITTED' } })
      return this.load(tx, poId)
    })
  }

  /**
   * Approves a PO. SUBMITTED → APPROVED — the snapshot moment (standard #7).
   * Freezes each line's `lineTotal` from its `unitCost` and qty, persists the
   * header `subtotal/taxAmount/total`, stamps the approver, and emits
   * `PurchaseOrderApproved` in the same transaction (standard #4).
   */
  async approve(poId: string) {
    const ctx = requireTenantContext()
    return this.inTx(async (tx) => {
      const po = await this.requirePo(tx, poId)
      this.assertTransition(po.status, 'APPROVED')

      const items = await tx.purchaseOrderItem.findMany({
        where: { poId },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: { id: true, qtyOrderedScaled: true, unitCost: true },
      })
      if (items.length === 0) {
        throw badRequest('PURCHASE_ORDER_EMPTY', 'A purchase order needs at least one line to approve.')
      }

      const totals = this.computeTotals(
        items.map((i) => ({ qtyOrderedScaled: i.qtyOrderedScaled, unitCost: i.unitCost })),
        po.taxRateBp
      )

      // Freeze the per-line total (unitCost/qty are already frozen on the row).
      for (let i = 0; i < items.length; i += 1) {
        await tx.purchaseOrderItem.update({
          where: { id: items[i]!.id },
          data: { lineTotal: totals.lineTotals[i]! },
        })
      }

      await tx.purchaseOrder.update({
        where: { id: poId },
        data: {
          status: 'APPROVED',
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          total: totals.total,
          approvedByUserId: ctx.userId ?? null,
          approvedAt: new Date(),
        },
      })

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: po.outletId,
        type: EVENT_TYPES.PURCHASE_ORDER_APPROVED,
        payload: {
          poId,
          poNumber: po.poNumber,
          supplierId: po.supplierId,
          subtotal: totals.subtotal.toString(),
          taxAmount: totals.taxAmount.toString(),
          total: totals.total.toString(),
        },
      })
      return this.load(tx, poId)
    })
  }

  /**
   * Receives goods against an APPROVED (or partially-received) PO — S6-07/08,
   * design §4.5. This is the only PO verb that moves stock. For each line it:
   *
   *   1. appends a `StockMovement type=PURCHASE` (+qty, `costPerUnit = unitCost`,
   *      `refType='purchase_order'`, `refId=poId`) — the movement row IS the
   *      receipt record (standard #3), it raises on-hand AND feeds moving-average
   *      valuation (§4.3) in one write;
   *   2. accumulates `qtyReceivedScaled` on the PO line (for partial tracking).
   *
   * Status is derived from receipt progress: any line still short → RECEIVING;
   * every line fully received → RECEIVED. A follow-up partial that leaves the PO
   * in RECEIVING is a legal no-transition (the machine declares no self-loop, so
   * we only assert when the status actually changes). Over-receipt (more than a
   * line's outstanding qty) is rejected. `GoodsReceived` is emitted in the same
   * transaction for Accounting (standard #4); it never writes journals itself (#5).
   */
  async receive(poId: string, input: ReceivePurchaseOrderInput) {
    const ctx = requireTenantContext()
    if (input.lines.length === 0) {
      throw badRequest('RECEIPT_EMPTY', 'A goods receipt needs at least one line.')
    }
    for (const line of input.lines) {
      if (line.qtyScaled <= 0n) {
        throw badRequest('INVALID_QTY', 'Received quantity must be a positive scaled integer.')
      }
    }

    return this.inTx(async (tx) => {
      const po = await this.requirePo(tx, poId)
      if (po.status !== 'APPROVED' && po.status !== 'RECEIVING') {
        throw conflict(
          'PURCHASE_ORDER_NOT_RECEIVABLE',
          `Purchase order is ${po.status}; goods are received only while APPROVED or RECEIVING.`
        )
      }

      const items = await tx.purchaseOrderItem.findMany({
        where: { poId },
        select: { id: true, variantId: true, qtyOrderedScaled: true, qtyReceivedScaled: true, unitCost: true },
      })
      const byId = new Map(items.map((it) => [it.id, it]))

      // Collapse duplicate lines for the same poItemId so the outstanding check
      // sees the full requested quantity, not each fragment in isolation.
      const requested = new Map<string, bigint>()
      for (const line of input.lines) {
        const item = byId.get(line.poItemId)
        if (!item) {
          throw notFound('PO_ITEM_NOT_FOUND', `Purchase-order line ${line.poItemId} is not on this PO.`)
        }
        requested.set(line.poItemId, (requested.get(line.poItemId) ?? 0n) + line.qtyScaled)
      }

      const receivedLines: { poItemId: string; variantId: string; qtyScaled: bigint; movementId: string; cost: bigint }[] = []
      for (const [poItemId, qtyScaled] of requested) {
        const item = byId.get(poItemId)!
        const outstanding = item.qtyOrderedScaled - item.qtyReceivedScaled
        if (qtyScaled > outstanding) {
          throw badRequest(
            'OVER_RECEIPT',
            `Cannot receive ${qtyScaled} against line ${poItemId}: only ${outstanding} outstanding.`
          )
        }

        // qtyOrderedScaled and StockMovement.qty share scaled base units, so the
        // received quantity maps straight through with no factor conversion.
        const movement = await this.stock.recordMovement(tx, {
          outletId: po.outletId,
          variantId: item.variantId,
          type: 'PURCHASE',
          qtyBaseScaled: qtyScaled,
          costPerUnit: item.unitCost,
          refType: 'purchase_order',
          refId: poId,
          ...(ctx.userId ? { userId: ctx.userId } : {}),
        })

        await tx.purchaseOrderItem.update({
          where: { id: poItemId },
          data: { qtyReceivedScaled: item.qtyReceivedScaled + qtyScaled },
        })

        receivedLines.push({
          poItemId,
          variantId: item.variantId,
          qtyScaled,
          movementId: movement.id,
          cost: movement.extendedCost,
        })
      }

      // Fully received when no line has any outstanding qty left after this receipt.
      const outstandingAfter = items.reduce((sum, it) => {
        const justReceived = requested.get(it.id) ?? 0n
        return sum + (it.qtyOrderedScaled - it.qtyReceivedScaled - justReceived)
      }, 0n)
      const nextStatus: PurchaseOrderStatus = outstandingAfter === 0n ? 'RECEIVED' : 'RECEIVING'

      // Only assert/persist a transition when the status actually changes — a
      // second partial receipt legitimately stays in RECEIVING (no self-loop).
      if (nextStatus !== po.status) {
        this.assertTransition(po.status, nextStatus)
        await tx.purchaseOrder.update({ where: { id: poId }, data: { status: nextStatus } })
      }

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: po.outletId,
        type: EVENT_TYPES.GOODS_RECEIVED,
        payload: {
          poId,
          poNumber: po.poNumber,
          supplierId: po.supplierId,
          status: nextStatus,
          totalCost: receivedLines.reduce((sum, l) => sum + l.cost, 0n).toString(),
          lines: receivedLines.map((l) => ({
            poItemId: l.poItemId,
            variantId: l.variantId,
            qtyScaled: l.qtyScaled.toString(),
            movementId: l.movementId,
            cost: l.cost.toString(),
          })),
        },
      })

      return this.load(tx, poId)
    })
  }

  /**
   * Cancels a PO with a required reason. Reachable from DRAFT/SUBMITTED/APPROVED;
   * the machine refuses once goods start arriving (that is a return, not a cancel).
   */
  async cancel(poId: string, reason: string) {
    const trimmed = reason.trim()
    if (trimmed === '') throw badRequest('CANCEL_REASON_REQUIRED', 'A cancellation reason is required.')

    return this.inTx(async (tx) => {
      const po = await this.requirePo(tx, poId)
      this.assertTransition(po.status, 'CANCELLED')
      await tx.purchaseOrder.update({
        where: { id: poId },
        data: { status: 'CANCELLED', cancelReason: trimmed },
      })
      return this.load(tx, poId)
    })
  }

  /* ---------------------------------------------------------------- internals */

  private inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.db as unknown as PrismaClient, fn)
  }

  /**
   * Inserts the header, assigning `poNumber = MAX+1` for the tenant. The unique
   * index is the hard guard; on a concurrent-create collision (P2002) retry once
   * — a second collision is astronomically unlikely and surfaces as the error.
   */
  private async createWithNumber(
    tx: Tx,
    input: CreatePurchaseOrderInput,
    taxRateBp: number
  ): Promise<string> {
    const ctx = requireTenantContext()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rows = await tx.$queryRaw<Array<{ next: number }>>`
        SELECT COALESCE(MAX("poNumber"), 0) + 1 AS next FROM "purchase_orders"
      `
      const next = rows[0]?.next ?? 1
      try {
        const po = await tx.purchaseOrder.create({
          data: {
            tenantId: ctx.tenantId,
            outletId: input.outletId,
            supplierId: input.supplierId,
            poNumber: next,
            status: 'DRAFT',
            expectedDate: input.expectedDate ?? null,
            taxRateBp,
            notes: this.orNull(input.notes),
            createdByUserId: ctx.userId ?? null,
          } as unknown as Prisma.PurchaseOrderCreateInput,
          select: { id: true },
        })
        return po.id
      } catch (err) {
        if (this.isUniqueViolation(err) && attempt === 0) continue
        throw err
      }
    }
    // Unreachable: the loop either returns or throws.
    throw conflict('PO_NUMBER_CONFLICT', 'Could not assign a purchase-order number; please retry.')
  }

  /** Deletes and re-inserts the full line set (DRAFT replace-all). */
  private async replaceLines(tx: Tx, poId: string, lines: PurchaseOrderLineInput[]): Promise<void> {
    await tx.purchaseOrderItem.deleteMany({ where: { poId } })
    let sort = 0
    for (const line of lines) {
      await tx.purchaseOrderItem.create({
        data: {
          poId,
          variantId: line.variantId,
          qtyOrderedScaled: line.qtyOrderedScaled,
          unitCost: line.unitCost ?? 0n,
          lineTotal: 0n, // frozen at APPROVED
          sortOrder: line.sortOrder ?? sort,
        } as unknown as Prisma.PurchaseOrderItemCreateInput,
      })
      sort += 1
    }
  }

  /**
   * Folds line unitCost × qty into per-line totals and the header
   * subtotal/tax/total (minor units, standard #2). Used by `approve` to persist
   * the frozen figures and by `load` to preview them while still DRAFT.
   */
  private computeTotals(
    lines: readonly { qtyOrderedScaled: bigint; unitCost: bigint }[],
    taxRateBp: number
  ): Totals {
    const lineTotals = lines.map((l) => extendedCost(l.qtyOrderedScaled, l.unitCost))
    const subtotal = Money.sum(lineTotals)
    const taxAmount = Money.applyRate(subtotal, taxRateBp)
    const total = Money.add(subtotal, taxAmount)
    return { lineTotals, subtotal, taxAmount, total }
  }

  /**
   * Reads one PO with its lines plus a derived `summary`. The summary previews
   * subtotal/tax/total from the current lines while DRAFT; once APPROVED its
   * inputs are frozen, so it equals the persisted header exactly.
   */
  private async load(client: Tx, poId: string) {
    const po = await client.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
    })
    if (!po) return null

    const totals = this.computeTotals(
      po.items.map((i) => ({ qtyOrderedScaled: i.qtyOrderedScaled, unitCost: i.unitCost })),
      po.taxRateBp
    )
    return {
      ...po,
      items: po.items.map((item, idx) => ({
        ...item,
        // A live preview while DRAFT; equals the frozen `lineTotal` post-APPROVED.
        lineTotalPreview: totals.lineTotals[idx] ?? 0n,
      })),
      summary: {
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        total: totals.total,
      },
    }
  }

  private async requirePo(tx: Tx, poId: string) {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: poId },
      select: {
        id: true,
        status: true,
        outletId: true,
        supplierId: true,
        poNumber: true,
        taxRateBp: true,
      },
    })
    if (!po) throw notFound('PURCHASE_ORDER_NOT_FOUND', `Purchase order ${poId} not found.`)
    return { ...po, status: po.status as PurchaseOrderStatus }
  }

  private async requireOutlet(tx: Tx, outletId: string): Promise<void> {
    const outlet = await tx.outlet.findUnique({ where: { id: outletId }, select: { id: true } })
    if (!outlet) throw notFound('OUTLET_NOT_FOUND', `Outlet ${outletId} not found.`)
  }

  private async requireSupplier(tx: Tx, supplierId: string): Promise<void> {
    const supplier = await tx.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true, isActive: true },
    })
    if (!supplier) throw notFound('SUPPLIER_NOT_FOUND', `Supplier ${supplierId} not found.`)
    if (!supplier.isActive) {
      throw badRequest('SUPPLIER_INACTIVE', 'Cannot raise a purchase order against an inactive supplier.')
    }
  }

  /** Every referenced variant must exist in this tenant. */
  private async requireVariants(tx: Tx, variantIds: string[]): Promise<void> {
    const unique = [...new Set(variantIds)]
    if (unique.length === 0) return
    const found = await tx.productVariant.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    })
    if (found.length !== unique.length) {
      throw notFound('VARIANT_NOT_FOUND', 'One or more purchase-order lines reference a missing variant.')
    }
  }

  private assertLines(lines: PurchaseOrderLineInput[]): void {
    if (lines.length === 0) {
      throw badRequest('PURCHASE_ORDER_EMPTY', 'A purchase order needs at least one line.')
    }
    for (const line of lines) {
      if (line.qtyOrderedScaled <= 0n) {
        throw badRequest('INVALID_QTY', 'Line quantity must be a positive scaled integer.')
      }
      if (line.unitCost !== undefined && line.unitCost < 0n) {
        throw badRequest('INVALID_UNIT_COST', 'Line unit cost cannot be negative.')
      }
    }
  }

  private assertTaxRate(taxRateBp: number | undefined): number {
    const rate = taxRateBp ?? 0
    if (!Number.isInteger(rate) || rate < 0) {
      throw badRequest('INVALID_TAX_RATE', 'Tax rate must be a non-negative integer in basis points.')
    }
    return rate
  }

  private assertEditable(status: PurchaseOrderStatus): void {
    if (!isEditable(status)) {
      throw conflict('PURCHASE_ORDER_NOT_EDITABLE', `Purchase order is ${status}; lines change only while DRAFT.`)
    }
  }

  private assertTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): void {
    try {
      purchaseOrderStateMachine.assert(from, to)
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        throw conflict('ILLEGAL_TRANSITION', err.message)
      }
      throw err
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
  }

  private orNull(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
}
