/**
 * Payment service — S5-01/02/03/04/05, design §7.
 *
 * Owns the two levels below the order: the `Bill` (what must be paid — created at
 * BILLED by `OrderService`) and the `Payment` (how it was paid — one row per
 * tender). It never touches the §6 pipeline or the order state machine's earlier
 * steps; its job is settlement.
 *
 * The rules it enforces (design §7):
 *   - A bill settles when SUM(payment.amount) >= bill.total (§7.1). When every
 *     bill on an order is settled the order transitions BILLED → PAID and emits
 *     `SaleCompleted` in the SAME transaction (standard #4) — POS never calls
 *     Accounting/Loyalty directly, it drops a self-contained snapshot on the
 *     outbox.
 *   - Split payment is just several Payment rows against one bill (§7.2); the
 *     change/settlement math is the pure `computeTender`.
 *   - A refund is a negative Payment with a reason (§7.4) — append-only, so the
 *     cash trail is never broken (standard #3).
 *
 * Tenant scoping is the extension's job (standard #1): no `where: { tenantId }`
 * appears here. Every mutation runs in `withTenantTransaction` so the RLS GUC is
 * bound and reads/writes go through `tx`.
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
import { EVENT_TYPES, allocate, allocateByWeights } from '@brewsync/shared'
import { badRequest, conflict, notFound } from '../http-error.js'
import { computeTender, TenderError } from './payment.settle.js'
import { ShiftService } from './shift.service.js'
import { StockDeductionService } from './stock-deduction.service.js'

type Tx = Prisma.TransactionClient

export interface AcceptPaymentInput {
  methodId: string
  /** Tender handed over, minor units, positive. */
  amountMinor: bigint
  /** Reference (card approval, QRIS txn id) — required when the method needs one. */
  refNo?: string | null
}

/**
 * How to split one order's single bill into several (§7.3). Either an even N-way
 * split, or explicit weights (e.g. seat shares) — both preserve the total
 * exactly through the shared `allocate`/`allocateByWeights` largest-remainder
 * helpers, so SUM(bill.total) === order total holds by construction.
 */
export type SplitBillInput =
  | { mode: 'even'; parts: number }
  | { mode: 'weights'; weights: bigint[] }

export interface RefundPaymentInput {
  /** Positive magnitude to refund, minor units — recorded as a negative Payment. */
  amountMinor: bigint
  /** Why the refund was issued (§7.4) — required for the audit trail. */
  reason: string
  /** Tender the refund is returned on; defaults to the bill's settling method context. */
  methodId: string
  refNo?: string | null
}

export class PaymentService {
  private readonly shifts: ShiftService

  constructor(private readonly db: BrewsyncClient) {
    this.shifts = new ShiftService(db)
  }

  /** Active tenders for this tenant, in display order (design §7.5). */
  async listMethods() {
    return this.db.paymentMethod.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
  }

  /** Bills for an order with each bill's tendered/remaining derived from payments. */
  async listBills(orderId: string) {
    const bills = await this.db.bill.findMany({
      where: { orderId },
      orderBy: { seq: 'asc' },
      include: { payments: { orderBy: { createdAt: 'asc' } } },
    })
    return bills.map((bill) => this.withBalances(bill))
  }

  /**
   * Accepts one tender against a bill (§7.1/§7.2). Validates the tender through
   * the pure `computeTender`, appends the Payment, and — if this tender settles
   * the bill and it is the last open bill on the order — flips the order to PAID
   * and emits `SaleCompleted`.
   */
  async accept(billId: string, input: AcceptPaymentInput) {
    const ctx = requireTenantContext()
    return this.inTx(async (tx) => {
      const bill = await tx.bill.findUnique({
        where: { id: billId },
        include: { payments: true },
      })
      if (!bill) throw notFound('BILL_NOT_FOUND', `Bill ${billId} not found.`)
      if (bill.status !== 'OPEN') {
        throw conflict('BILL_NOT_OPEN', `Bill is ${bill.status}; it can no longer take payment.`)
      }

      const method = await tx.paymentMethod.findUnique({ where: { id: input.methodId } })
      if (!method || !method.isActive) {
        throw notFound('PAYMENT_METHOD_NOT_FOUND', `Payment method ${input.methodId} not found.`)
      }
      const refNo = input.refNo?.trim() ? input.refNo.trim() : null
      if (method.needsRefNo && !refNo) {
        throw badRequest('REF_NO_REQUIRED', `${method.name} requires a reference number.`)
      }

      // Only prior positive tenders count toward what has been paid so far; a
      // refund row (negative) is a separate concern and does not re-open change.
      const priorTendered = bill.payments.reduce((acc, p) => (p.amount > 0n ? acc + p.amount : acc), 0n)

      let outcome
      try {
        outcome = computeTender({
          billTotal: bill.total,
          priorTendered,
          amount: input.amountMinor,
          methodCountsAsCash: method.countsAsCash,
        })
      } catch (err) {
        if (err instanceof TenderError) throw this.mapTenderError(err)
        throw err
      }

      const payment = await tx.payment.create({
        data: {
          billId,
          methodId: method.id,
          amount: input.amountMinor,
          changeGiven: outcome.changeGiven,
          refNo,
          createdByUserId: ctx.userId ?? null,
        } as unknown as Prisma.PaymentCreateInput,
        select: { id: true },
      })

      // A cash tender moves the drawer (§14.2). Net cash in = amount − change
      // given; card/QRIS never touch the drawer. Skipped silently when no shift
      // is open — the Payment is still recorded either way.
      if (method.countsAsCash) {
        const netCash = input.amountMinor - outcome.changeGiven
        if (netCash > 0n) {
          const order = await tx.order.findUniqueOrThrow({
            where: { id: bill.orderId },
            select: { outletId: true },
          })
          await this.shifts.recordCashSale(tx, {
            outletId: order.outletId,
            amountMinor: netCash,
            paymentId: payment.id,
            isRefund: false,
            userId: ctx.userId ?? null,
          })
        }
      }

      if (outcome.settles) {
        await tx.bill.update({
          where: { id: billId },
          data: { status: 'PAID', paidAt: new Date() },
        })
        await this.settleOrderIfFullyPaid(tx, bill.orderId, ctx)
      }

      return this.loadBill(tx, billId)
    })
  }

  /**
   * Splits an order's single OPEN bill into several (§7.3) — the split-bill
   * operation on top of the one bill `OrderService.bill()` created. Only legal
   * before any tender lands (a partly-paid bill cannot be re-partitioned) and
   * while the order is BILLED. The per-bill totals come from the money helpers,
   * which preserve the sum exactly, so the hard invariant SUM(bill.total) ===
   * order total is guaranteed by construction, not by re-checking.
   */
  async split(orderId: string, input: SplitBillInput) {
    return this.inTx(async (tx) => {
      const bills = await tx.bill.findMany({
        where: { orderId },
        orderBy: { seq: 'asc' },
        include: { payments: true },
      })
      if (bills.length === 0) {
        throw notFound('BILL_NOT_FOUND', `Order ${orderId} has no bill to split.`)
      }
      if (bills.length > 1) {
        throw conflict('ALREADY_SPLIT', `Order ${orderId} is already split into ${bills.length} bills.`)
      }
      const source = bills[0]!
      if (source.status !== 'OPEN' || source.payments.length > 0) {
        throw conflict('BILL_NOT_SPLITTABLE', 'A bill can only be split before any payment is taken.')
      }

      const parts =
        input.mode === 'even'
          ? allocate(source.total, input.parts).length
          : input.weights.length
      if (parts < 2) {
        throw badRequest('INVALID_SPLIT', 'A split must produce at least two bills.')
      }

      const totals =
        input.mode === 'even'
          ? allocate(source.total, input.parts)
          : allocateByWeights(source.total, input.weights)
      const subtotals =
        input.mode === 'even'
          ? allocate(source.subtotal, input.parts)
          : allocateByWeights(source.subtotal, input.weights)

      // Replace the single seq-1 bill with N fresh bills. Safe: no payments exist.
      await tx.bill.delete({ where: { id: source.id } })
      for (let i = 0; i < totals.length; i += 1) {
        await tx.bill.create({
          data: {
            orderId,
            seq: i + 1,
            subtotal: subtotals[i]!,
            total: totals[i]!,
            label: `Bill ${i + 1} of ${totals.length}`,
          } as unknown as Prisma.BillCreateInput,
        })
      }

      return this.listBills(orderId)
    })
  }

  /**
   * Issues a refund against a paid bill (§7.4). A refund is never a delete: it is
   * a negative Payment row carrying a reason, so the cash trail stays append-only
   * (standard #3). Emits `RefundIssued` in the same transaction (standard #4).
   * Guarded by PAYMENT_REFUND at the route.
   */
  async refund(billId: string, input: RefundPaymentInput) {
    const ctx = requireTenantContext()
    if (input.amountMinor <= 0n) {
      throw badRequest('INVALID_REFUND', 'Refund amount must be positive.')
    }
    const reason = input.reason.trim()
    if (!reason) throw badRequest('REFUND_REASON_REQUIRED', 'A refund requires a reason.')

    return this.inTx(async (tx) => {
      const bill = await tx.bill.findUnique({
        where: { id: billId },
        include: { payments: true },
      })
      if (!bill) throw notFound('BILL_NOT_FOUND', `Bill ${billId} not found.`)

      // Net of prior refunds: you cannot return more than was actually collected.
      const netCollected = bill.payments.reduce((acc, p) => acc + p.amount, 0n)
      if (input.amountMinor > netCollected) {
        throw badRequest(
          'REFUND_EXCEEDS_COLLECTED',
          'Refund cannot exceed the amount collected on this bill.'
        )
      }

      const method = await tx.paymentMethod.findUnique({ where: { id: input.methodId } })
      if (!method) {
        throw notFound('PAYMENT_METHOD_NOT_FOUND', `Payment method ${input.methodId} not found.`)
      }

      const order = await tx.order.findUniqueOrThrow({
        where: { id: bill.orderId },
        select: { outletId: true },
      })

      const payment = await tx.payment.create({
        data: {
          billId,
          methodId: method.id,
          amount: -input.amountMinor,
          changeGiven: 0n,
          refNo: input.refNo?.trim() ? input.refNo.trim() : null,
          reason,
          createdByUserId: ctx.userId ?? null,
        } as unknown as Prisma.PaymentCreateInput,
        select: { id: true },
      })

      // A cash refund takes money out of the drawer (§14.2). Card/QRIS refunds
      // reverse on the network, not the till.
      if (method.countsAsCash) {
        await this.shifts.recordCashSale(tx, {
          outletId: order.outletId,
          amountMinor: input.amountMinor,
          paymentId: payment.id,
          isRefund: true,
          userId: ctx.userId ?? null,
        })
      }

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: order.outletId,
        type: EVENT_TYPES.REFUND_ISSUED,
        payload: {
          billId,
          orderId: bill.orderId,
          methodId: method.id,
          amount: -input.amountMinor,
          reason,
        },
      })

      return this.loadBill(tx, billId)
    })
  }

  /* ---------------------------------------------------------------- internals */

  private inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.db as unknown as PrismaClient, fn)
  }

  /**
   * When the last open bill on an order settles, the order is PAID. Emits
   * `SaleCompleted` (§8.1) with a self-contained snapshot — bills, items,
   * charges, payments — so a consumer (Accounting, Loyalty) never queries back
   * into POS (§8.2). Money fields are serialized as strings by the outbox.
   */
  private async settleOrderIfFullyPaid(
    tx: Tx,
    orderId: string,
    ctx: { tenantId: string; userId?: string | null }
  ) {
    const bills = await tx.bill.findMany({
      where: { orderId },
      include: { payments: { orderBy: { createdAt: 'asc' } } },
    })
    const allPaid = bills.length > 0 && bills.every((b) => b.status === 'PAID')
    if (!allPaid) return

    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        charges: { orderBy: { sortOrder: 'asc' } },
      },
    })
    if (order.status !== 'BILLED') return // already PAID/closed by a concurrent path

    await tx.order.update({ where: { id: orderId }, data: { status: 'PAID' } })

    // Stock deduction at PAID (§4.2) — a no-op unless the outlet deducts at PAID.
    // Idempotent on ('order', orderId): a retried settle never double-deducts.
    await new StockDeductionService(tx as unknown as BrewsyncClient).deductForOrder(
      tx,
      {
        id: orderId,
        outletId: order.outletId,
        items: order.items.map((i) => ({ variantId: i.variantId, qty: i.qty })),
      },
      'PAID',
      ctx.userId ?? null
    )

    await emitEvent(tx as unknown as OutboxCapableTx, {
      tenantId: ctx.tenantId,
      outletId: order.outletId,
      type: EVENT_TYPES.SALE_COMPLETED,
      payload: {
        orderId,
        outletId: order.outletId,
        channel: order.channel,
        salesMethod: order.salesMethod,
        bills: bills.map((b) => ({
          id: b.id,
          seq: b.seq,
          subtotal: b.subtotal,
          total: b.total,
          payments: b.payments.map((p) => ({
            id: p.id,
            methodId: p.methodId,
            amount: p.amount,
            changeGiven: p.changeGiven,
            refNo: p.refNo,
          })),
        })),
        items: order.items.map((i) => ({
          id: i.id,
          variantId: i.variantId,
          qty: i.qty,
          nameSnapshot: i.nameSnapshot,
          priceSnapshot: i.priceSnapshot,
          modifierDeltaSnapshot: i.modifierDeltaSnapshot,
        })),
        charges: order.charges.map((c) => ({
          kind: c.kind,
          label: c.label,
          amount: c.amount,
          taxable: c.taxable,
        })),
      },
    })
  }

  private async loadBill(client: Tx, billId: string) {
    const bill = await client.bill.findUnique({
      where: { id: billId },
      include: { payments: { orderBy: { createdAt: 'asc' } } },
    })
    if (!bill) throw notFound('BILL_NOT_FOUND', `Bill ${billId} not found.`)
    return this.withBalances(bill)
  }

  /** Folds derived tendered/remaining onto a bill (never persisted — SUM is truth). */
  private withBalances<T extends { total: bigint; payments: { amount: bigint }[] }>(bill: T) {
    const tendered = bill.payments.reduce((acc, p) => acc + p.amount, 0n)
    const remaining = bill.total - tendered
    return { ...bill, tendered, remaining: remaining > 0n ? remaining : 0n }
  }

  private mapTenderError(err: TenderError) {
    if (err.code === 'BILL_ALREADY_SETTLED') return conflict('BILL_ALREADY_SETTLED', err.message)
    return badRequest(err.code, err.message)
  }
}
