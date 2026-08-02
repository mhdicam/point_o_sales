/**
 * Stock service — S6-01/02/04, design §4 (standards #1, #3).
 *
 * The one place stock changes. Every change is an append-only `StockMovement`
 * row; on-hand is SUM(qty) and inventory value is a fold over the ledger — there
 * is no stockOnHand or averageCost column to drift (standard #3, the brewsync
 * 1.0 lesson in §4). Quantities are scaled base units (see @brewsync/shared
 * inventory helpers); `costPerUnit` is minor units per one base unit.
 *
 * Tenant scoping is the extension's job (standard #1): no `where: { tenantId }`
 * here. Mutations run in `withTenantTransaction`; the sale path (S6-02) reuses
 * the caller's transaction so a consumption row and the sale commit atomically.
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
import {
  EVENT_TYPES,
  valuate,
  avgCostOf,
  toBaseScaled,
  fromBaseScaled,
  extendedCost,
  type StockLot,
} from '@brewsync/shared'
import { badRequest, notFound } from '../http-error.js'

type Tx = Prisma.TransactionClient

/** Movement types a user can create by hand; sale/purchase rows are system-written. */
export type ManualStockMovementType = 'ADJUSTMENT' | 'WASTE' | 'TRANSFER' | 'PRODUCTION'

export interface AdjustStockInput {
  outletId: string
  variantId: string
  /** Signed quantity in the variant's stock unit, scaled by UNIT_FACTOR_SCALE. */
  qtyScaled: bigint
  type: ManualStockMovementType
  /** Cost per one base unit, minor units. Optional; a pure count omits it. */
  costPerUnit?: bigint | null
  reason?: string | null
}

export interface OnHand {
  variantId: string
  outletId: string
  /** On-hand in scaled base units (SUM of the ledger). */
  onHandBaseScaled: bigint
  /** On-hand presented in the variant's stock unit, scaled. FE renders this. */
  onHandStockScaled: bigint
  avgCost: bigint
  value: bigint
}

/** Outlet-wide valuation summary — the grand total plus one line per variant. */
export interface OutletValuation {
  outletId: string
  /** SUM of every variant's inventory value at this outlet, minor units. */
  totalValue: bigint
  /** Per-variant on-hand + value, highest value first. */
  lines: OnHand[]
}

/** What a recorded movement reports back — id plus its snapshotted valuation. */
export interface RecordedMovement {
  id: string
  /** Minor units per one base unit at the moment of the movement (snapshot). */
  costPerUnit: bigint | null
  /**
   * Signed extended cost of the movement, minor units = qty * cost / SCALE. For
   * a SALE_CONSUMPTION (qty < 0) this is negative; negate it for the positive
   * COGS the movement contributes (§4.3).
   */
  extendedCost: bigint
}

export class StockService {
  constructor(private readonly db: BrewsyncClient) {}

  /**
   * On-hand + valuation for one variant at one outlet, folded from the ledger
   * (§4.3). Never reads a cached balance — the SUM/fold is the truth (standard #3).
   */
  async onHand(outletId: string, variantId: string): Promise<OnHand> {
    const variant = await this.db.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true, stockUnit: { select: { factor: true } } },
    })
    if (!variant) throw notFound('VARIANT_NOT_FOUND', `Variant ${variantId} not found.`)

    const lots = await this.ledger(this.db as unknown as Tx, outletId, variantId)
    const v = valuate(lots)
    const factor = variant.stockUnit?.factor ?? null
    return {
      variantId,
      outletId,
      onHandBaseScaled: v.onHand,
      onHandStockScaled: factor ? fromBaseScaled(v.onHand, factor) : v.onHand,
      avgCost: v.avgCost,
      value: v.value,
    }
  }

  /**
   * A stock take / waste / manual correction (§4.1). Converts the input quantity
   * to scaled base units, appends one movement, and emits `StockAdjusted` in the
   * same transaction (standard #4). A stock take is an ADJUSTMENT, never an
   * overwrite of a balance — there is no balance to overwrite.
   */
  async adjust(input: AdjustStockInput) {
    const ctx = requireTenantContext()
    if (input.qtyScaled === 0n) {
      throw badRequest('INVALID_QTY', 'A stock adjustment quantity cannot be zero.')
    }
    const reason = input.reason?.trim() ? input.reason.trim() : null
    if ((input.type === 'ADJUSTMENT' || input.type === 'WASTE') && !reason) {
      throw badRequest('REASON_REQUIRED', `${input.type} requires a reason.`)
    }

    return this.inTx(async (tx) => {
      const factor = await this.requireStockFactor(tx, input.variantId)
      await this.requireOutlet(tx, input.outletId)
      const qtyBase = toBaseScaled(input.qtyScaled, factor)

      const movement = await tx.stockMovement.create({
        data: {
          outletId: input.outletId,
          variantId: input.variantId,
          type: input.type,
          qty: qtyBase,
          costPerUnit: input.costPerUnit ?? null,
          reason,
          createdByUserId: ctx.userId ?? null,
        } as unknown as Prisma.StockMovementCreateInput,
        select: { id: true },
      })

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: input.outletId,
        type: EVENT_TYPES.STOCK_ADJUSTED,
        payload: {
          movementId: movement.id,
          outletId: input.outletId,
          variantId: input.variantId,
          type: input.type,
          qty: qtyBase,
        },
      })

      return this.onHand(input.outletId, input.variantId)
    })
  }

  /**
   * The recent ledger for a variant at an outlet, newest first — the inventory
   * card / audit view. Read-only; the valuation columns come from `onHand`.
   */
  async history(outletId: string, variantId: string, limit = 100) {
    return await this.db.stockMovement.findMany({
      where: { outletId, variantId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    })
  }

  /**
   * Outlet-wide inventory valuation (§4.3) — the on-hand + value of every variant
   * that has ever moved at this outlet, each folded from its own ledger, plus the
   * grand total value. Derived, never a stored balance (standard #3). The per-line
   * `onHand`/`value` are the same figures a single-variant `onHand()` returns.
   */
  async outletValuation(outletId: string): Promise<OutletValuation> {
    // Every variant with at least one movement here. Scoping is the extension's
    // job (standard #1); this reads only rows for the request's tenant. We dedupe
    // in JS rather than lean on Prisma `distinct` — the typed scalar-field enum
    // pushes the dynamic-extension client past TS's instantiation-depth limit.
    const rows = await this.db.stockMovement.findMany({
      where: { outletId },
      select: { variantId: true },
    })
    const variantIds = [...new Set(rows.map((r) => r.variantId))]
    const lines: OnHand[] = []
    let totalValue = 0n
    for (const variantId of variantIds) {
      const line = await this.onHand(outletId, variantId)
      lines.push(line)
      totalValue += line.value
    }
    // Highest-value first so the summary leads with what matters.
    lines.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
    return { outletId, totalValue, lines }
  }

  /**
   * Appends one consumption/production/purchase movement inside a caller's
   * transaction (S6-02, S6-07). Kept `tx`-taking so it commits atomically with
   * the sale or receipt that drove it. `qtyBaseScaled` is already in scaled base
   * units and already signed. Returns the created movement id.
   *
   * For a SALE_CONSUMPTION the caller passes no cost; this method snapshots the
   * moving-average cost at this instant so historical COGS never shifts
   * (standard #7 spirit) — the fold that read `costPerUnit` back agrees exactly.
   * Returns the id plus the snapshotted cost and its extended value so the sale
   * path can total COGS from the exact figures it wrote (S6-04).
   */
  async recordMovement(
    tx: Tx,
    args: {
      outletId: string
      variantId: string
      type: Prisma.StockMovementCreateInput['type']
      qtyBaseScaled: bigint
      costPerUnit?: bigint | null
      refType?: string | null
      refId?: string | null
      userId?: string | null
    }
  ): Promise<RecordedMovement> {
    let cost = args.costPerUnit ?? null
    if (cost === null && args.type === 'SALE_CONSUMPTION') {
      const lots = await this.ledger(tx, args.outletId, args.variantId)
      const v = valuate(lots)
      cost = avgCostOf(v.onHand, v.value)
    }

    const movement = await tx.stockMovement.create({
      data: {
        outletId: args.outletId,
        variantId: args.variantId,
        type: args.type,
        qty: args.qtyBaseScaled,
        costPerUnit: cost,
        refType: args.refType ?? null,
        refId: args.refId ?? null,
        createdByUserId: args.userId ?? null,
      } as unknown as Prisma.StockMovementCreateInput,
      select: { id: true },
    })
    return {
      id: movement.id,
      costPerUnit: cost,
      extendedCost: cost === null ? 0n : extendedCost(args.qtyBaseScaled, cost),
    }
  }

  /**
   * True if any stock movement already references (refType, refId). The sale
   * path uses this to stay idempotent — an OrderSent redelivered by the outbox
   * must not deduct stock twice (standard #4 consumers are idempotent).
   */
  async hasMovementsFor(tx: Tx, refType: string, refId: string): Promise<boolean> {
    const existing = await tx.stockMovement.findFirst({
      where: { refType, refId },
      select: { id: true },
    })
    return existing !== null
  }

  /* ---------------------------------------------------------------- internals */

  private inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.db as unknown as PrismaClient, fn)
  }

  /** The valuation-ready ledger for a variant at an outlet, in creation order. */
  private async ledger(
    client: Tx,
    outletId: string,
    variantId: string
  ): Promise<StockLot[]> {
    const rows = await client.stockMovement.findMany({
      where: { outletId, variantId },
      orderBy: { createdAt: 'asc' },
      select: { qty: true, costPerUnit: true },
    })
    return rows.map((r) => ({ qty: r.qty, costPerUnit: r.costPerUnit }))
  }

  private async requireStockFactor(tx: Tx, variantId: string): Promise<bigint> {
    const variant = await tx.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true, stockUnit: { select: { factor: true } } },
    })
    if (!variant) throw notFound('VARIANT_NOT_FOUND', `Variant ${variantId} not found.`)
    if (!variant.stockUnit) {
      throw badRequest(
        'NO_STOCK_UNIT',
        'This variant has no stock unit, so it cannot hold stock. Set a stock unit first.'
      )
    }
    return variant.stockUnit.factor
  }

  private async requireOutlet(tx: Tx, outletId: string): Promise<void> {
    const outlet = await tx.outlet.findUnique({ where: { id: outletId }, select: { id: true } })
    if (!outlet) throw notFound('OUTLET_NOT_FOUND', `Outlet ${outletId} not found.`)
  }
}
