/**
 * Shift service — S5-06/07, design §14.
 *
 * Owns the cash drawer's lifecycle: a `Shift` (a cashier's till session) and its
 * `CashMovement` rows (the append-only drawer ledger). The drawer's balance is
 * never a stored column — it is always SUM over the movements (standard #3), so
 * this service inserts movement rows and derives expected cash on close; it never
 * UPDATEs a running total.
 *
 * The rules it enforces (design §14):
 *   - Open takes an opening float, writes the baseline OPENING_FLOAT movement,
 *     and emits `ShiftOpened` (§14.1) in the same transaction (standard #4). At
 *     most one OPEN shift per (outlet, register) — the DB partial unique index is
 *     the hard guard; this service surfaces the collision as a 409.
 *   - During the shift, cash tenders and refunds append CASH_SALE / CASH_REFUND
 *     rows (driven from the payment path via `recordCashSale`), and manual
 *     PAID_IN / PAID_OUT / DROP rows require a reason where §14.2 says so.
 *   - Close computes expectedCash = openingFloat + SUM(movements), takes the
 *     counted cash, derives the variance, requires a reason when it is out of the
 *     outlet's tolerance (§14.3), and emits `ShiftClosed` with the reconciliation
 *     figures in the same transaction.
 *
 * Tenant scoping is the extension's job (standard #1): no `where: { tenantId }`
 * here. Every mutation runs in `withTenantTransaction`.
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
import { EVENT_TYPES } from '@brewsync/shared'
import { badRequest, conflict, notFound } from '../http-error.js'
import { expectedCash, cashVariance, varianceNeedsReason } from './shift.settle.js'

type Tx = Prisma.TransactionClient

/** Movement types a cashier can create by hand (system rows are written internally). */
export type ManualMovementType = 'PAID_IN' | 'PAID_OUT' | 'DROP'

export interface OpenShiftInput {
  outletId: string
  registerId?: string | null
  /** Cash placed in the drawer at open, minor units, non-negative. */
  openingFloatMinor: bigint
}

export interface CloseShiftInput {
  /** Physical cash counted at close, minor units, non-negative. */
  closingCountedCashMinor: bigint
  /** Required when the variance is out of the outlet tolerance (§14.3). */
  reason?: string | null
}

export interface CashMovementInput {
  type: ManualMovementType
  /** Magnitude, minor units, positive. The sign is applied from the type. */
  amountMinor: bigint
  reason?: string | null
}

export class ShiftService {
  constructor(private readonly db: BrewsyncClient) {}

  /**
   * The OPEN shift for an (outlet, register), or null. Folds the derived drawer
   * balance on like `load` so the client never sums the ledger (standard #2/#3).
   */
  async current(outletId: string, registerId?: string | null) {
    const shift = await this.db.shift.findFirst({
      where: { outletId, registerId: registerId ?? null, status: 'OPEN' },
      include: { movements: { orderBy: { createdAt: 'asc' } } },
    })
    if (!shift) return null
    const drawer = shift.movements.reduce((acc, m) => acc + m.amount, 0n)
    return { ...shift, drawerBalance: drawer }
  }

  /**
   * Opens a shift (§14.1). Writes the OPENING_FLOAT movement so the drawer
   * balance is derivable from the ledger alone, and emits `ShiftOpened`. The
   * one-open-per-register rule is enforced by a partial unique index; a
   * collision surfaces as 409.
   */
  async open(input: OpenShiftInput) {
    const ctx = requireTenantContext()
    if (!ctx.userId) throw badRequest('NO_USER', 'Opening a shift requires an authenticated user.')
    if (input.openingFloatMinor < 0n) {
      throw badRequest('INVALID_FLOAT', 'Opening float cannot be negative.')
    }
    const registerId = input.registerId?.trim() ? input.registerId.trim() : null
    const userId = ctx.userId

    return this.inTx(async (tx) => {
      await this.requireOutlet(tx, input.outletId)

      let shift
      try {
        shift = await tx.shift.create({
          data: {
            outletId: input.outletId,
            registerId,
            openedByUserId: userId,
            openingFloat: input.openingFloatMinor,
            status: 'OPEN',
          } as unknown as Prisma.ShiftCreateInput,
          select: { id: true, outletId: true },
        })
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw conflict('SHIFT_ALREADY_OPEN', 'A shift is already open on this register.')
        }
        throw err
      }

      if (input.openingFloatMinor > 0n) {
        await tx.cashMovement.create({
          data: {
            shiftId: shift.id,
            type: 'OPENING_FLOAT',
            amount: input.openingFloatMinor,
            createdByUserId: userId,
          } as unknown as Prisma.CashMovementCreateInput,
        })
      }

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: shift.outletId,
        type: EVENT_TYPES.SHIFT_OPENED,
        payload: {
          shiftId: shift.id,
          outletId: shift.outletId,
          registerId,
          openingFloat: input.openingFloatMinor,
        },
      })

      return this.load(tx, shift.id)
    })
  }

  /**
   * Appends a manual cash movement (§14.2). PAID_OUT and DROP subtract; PAID_IN
   * adds; all three require a reason (they are the discretionary drawer moves).
   */
  async addMovement(shiftId: string, input: CashMovementInput) {
    const ctx = requireTenantContext()
    if (input.amountMinor <= 0n) {
      throw badRequest('INVALID_AMOUNT', 'A cash movement amount must be positive.')
    }
    const reason = input.reason?.trim() ? input.reason.trim() : null
    if (!reason) {
      throw badRequest('REASON_REQUIRED', `${input.type} requires a reason.`)
    }

    return this.inTx(async (tx) => {
      const shift = await this.requireOpenShift(tx, shiftId)
      const signed = input.type === 'PAID_IN' ? input.amountMinor : -input.amountMinor
      await tx.cashMovement.create({
        data: {
          shiftId: shift.id,
          type: input.type,
          amount: signed,
          reason,
          createdByUserId: ctx.userId ?? null,
        } as unknown as Prisma.CashMovementCreateInput,
      })
      return this.load(tx, shiftId)
    })
  }

  /**
   * Closes a shift (§14.3). Derives expectedCash from the movement ledger, takes
   * the counted cash, computes the variance, and requires a reason when it is out
   * of the outlet's tolerance. Emits `ShiftClosed` with the reconciliation
   * figures in the same transaction.
   */
  async close(shiftId: string, input: CloseShiftInput) {
    const ctx = requireTenantContext()
    if (input.closingCountedCashMinor < 0n) {
      throw badRequest('INVALID_COUNT', 'Counted cash cannot be negative.')
    }

    return this.inTx(async (tx) => {
      const shift = await this.requireOpenShift(tx, shiftId)

      const movementSum = await this.sumMovements(tx, shiftId)
      const expected = expectedCash(movementSum)
      const variance = cashVariance(input.closingCountedCashMinor, expected)

      const outlet = await tx.outlet.findUniqueOrThrow({
        where: { id: shift.outletId },
        select: { cashVarianceToleranceMinor: true },
      })
      const reason = input.reason?.trim() ? input.reason.trim() : null
      if (varianceNeedsReason(variance, outlet.cashVarianceToleranceMinor) && !reason) {
        throw badRequest(
          'VARIANCE_REASON_REQUIRED',
          'The cash variance is outside tolerance and needs a reason.'
        )
      }

      await tx.shift.update({
        where: { id: shiftId },
        data: {
          status: 'CLOSED',
          closedByUserId: ctx.userId ?? null,
          closingCountedCash: input.closingCountedCashMinor,
          expectedCash: expected,
          cashVariance: variance,
          closedAt: new Date(),
        },
      })

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: shift.outletId,
        type: EVENT_TYPES.SHIFT_CLOSED,
        payload: {
          shiftId,
          outletId: shift.outletId,
          expectedCash: expected,
          closingCountedCash: input.closingCountedCashMinor,
          cashVariance: variance,
          reason,
        },
      })

      return this.load(tx, shiftId)
    })
  }

  /**
   * Records a cash tender (or refund) against the currently-open shift for an
   * outlet (§14.2). Called from the payment path inside its transaction, so it
   * takes the caller's `tx` and never opens its own. A card/QRIS tender never
   * calls this — only `countsAsCash` methods touch the drawer. If no shift is
   * open, the movement is skipped (cash can be taken with the drawer closed in
   * some flows); the Payment row still records the tender regardless.
   */
  async recordCashSale(
    tx: Tx,
    args: { outletId: string; amountMinor: bigint; paymentId: string; isRefund: boolean; userId?: string | null }
  ): Promise<void> {
    const shift = await tx.shift.findFirst({
      where: { outletId: args.outletId, status: 'OPEN' },
      select: { id: true },
    })
    if (!shift) return

    const magnitude = args.amountMinor < 0n ? -args.amountMinor : args.amountMinor
    await tx.cashMovement.create({
      data: {
        shiftId: shift.id,
        type: args.isRefund ? 'CASH_REFUND' : 'CASH_SALE',
        amount: args.isRefund ? -magnitude : magnitude,
        refType: 'payment',
        refId: args.paymentId,
        createdByUserId: args.userId ?? null,
      } as unknown as Prisma.CashMovementCreateInput,
    })
  }

  /* ---------------------------------------------------------------- internals */

  private inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.db as unknown as PrismaClient, fn)
  }

  private async sumMovements(tx: Tx, shiftId: string): Promise<bigint> {
    const agg = await tx.cashMovement.aggregate({
      where: { shiftId },
      _sum: { amount: true },
    })
    return agg._sum.amount ?? 0n
  }

  private async load(client: Tx | BrewsyncClient, shiftId: string) {
    const shift = await client.shift.findUnique({
      where: { id: shiftId },
      include: { movements: { orderBy: { createdAt: 'asc' } } },
    })
    if (!shift) throw notFound('SHIFT_NOT_FOUND', `Shift ${shiftId} not found.`)
    // Fold the derived running drawer balance on for the read model — never
    // persisted (standard #3): the SUM is the truth.
    const drawer = shift.movements.reduce((acc, m) => acc + m.amount, 0n)
    return { ...shift, drawerBalance: drawer }
  }

  private async requireOpenShift(tx: Tx, shiftId: string) {
    const shift = await tx.shift.findUnique({
      where: { id: shiftId },
      select: { id: true, outletId: true, status: true },
    })
    if (!shift) throw notFound('SHIFT_NOT_FOUND', `Shift ${shiftId} not found.`)
    if (shift.status !== 'OPEN') {
      throw conflict('SHIFT_NOT_OPEN', `Shift is ${shift.status}; it can no longer take movements.`)
    }
    return shift
  }

  private async requireOutlet(tx: Tx, outletId: string): Promise<void> {
    const outlet = await tx.outlet.findUnique({ where: { id: outletId }, select: { id: true } })
    if (!outlet) throw notFound('OUTLET_NOT_FOUND', `Outlet ${outletId} not found.`)
  }

  /** True for a Postgres unique-constraint violation (Prisma P2002). */
  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'P2002'
    )
  }
}
