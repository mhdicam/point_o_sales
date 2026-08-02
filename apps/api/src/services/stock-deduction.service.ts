/**
 * Stock deduction on sale — S6-02, design §4.2 (standards #3, #4).
 *
 * The seam between selling and inventory. When an order reaches its outlet's
 * `stockDeductionPoint` (SENT or PAID), each line consumes stock:
 *
 *   - a STOCKED variant deducts ITSELF — qty (sell units) → its stock base units;
 *   - a MADE_TO_ORDER variant with `features.recipe` on EXPLODES its recipe to
 *     base ingredients (design §3.4) and deducts each;
 *   - a SERVICE variant, or a MADE_TO_ORDER variant with no recipe, consumes
 *     nothing.
 *
 * It runs inside the caller's transaction (the SENT update in OrderService, the
 * settle in PaymentService) so consumption and the state change commit together
 * (standard #4). It is idempotent on `('order', orderId)`: an OrderSent the
 * outbox redelivers, or a retried settle, must never deduct twice — the guard is
 * a single existence check before any write.
 *
 * There is no balance to decrement — every deduction is one append-only
 * SALE_CONSUMPTION row (standard #3); on-hand stays SUM(qty). Cost is left null
 * so StockService snapshots the moving-average at this instant (S6-04).
 */

import {
  type BrewsyncClient,
  type Prisma,
  type OutboxCapableTx,
  requireTenantContext,
  emitEvent,
} from '@brewsync/db'
import { EVENT_TYPES, explodeRecipe, toBaseScaled, UNIT_FACTOR_SCALE } from '@brewsync/shared'
import { StockService } from './stock.service.js'
import { RecipeService } from './recipe.service.js'
import { FeatureService } from './feature.service.js'

type Tx = Prisma.TransactionClient

/** One base ingredient consumed by an order, with its snapshotted COGS. */
interface CogsLine {
  variantId: string
  /** Consumed base units, scaled — negative (an outbound movement). */
  qtyBaseScaled: bigint
  /** Positive cost of this consumption, minor units (§4.3). */
  cost: bigint
}

/** The order shape this service needs — id, outlet, and its lines. */
interface DeductibleOrder {
  id: string
  outletId: string
  items: { variantId: string; qty: number }[]
}

export class StockDeductionService {
  private readonly stock: StockService
  private readonly recipes: RecipeService

  constructor(db: BrewsyncClient) {
    this.stock = new StockService(db)
    this.recipes = new RecipeService(db)
  }

  /**
   * Deducts stock for one order inside the caller's transaction. A no-op if this
   * order already produced consumption rows (idempotent, standard #4) or if the
   * outlet's deduction point differs from `point`.
   *
   * @param point the moment this call represents (SENT or PAID) — the outlet
   *   only deducts at its configured point, so both hooks can call unconditionally.
   */
  async deductForOrder(
    tx: Tx,
    order: DeductibleOrder,
    point: 'SENT' | 'PAID',
    userId?: string | null
  ): Promise<void> {
    const outlet = await tx.outlet.findUnique({
      where: { id: order.outletId },
      select: { stockDeductionPoint: true },
    })
    if (!outlet || outlet.stockDeductionPoint !== point) return

    // Idempotency: one existence check guards the whole order (standard #4).
    if (await this.stock.hasMovementsFor(tx, 'order', order.id)) return

    if (order.items.length === 0) return

    const recipeEnabled = await new FeatureService(tx as unknown as BrewsyncClient).isEnabled(
      'recipe'
    )

    // The finished variants sold, with their effective fulfillment type + the
    // sell/stock factors we need to turn a sell-unit count into base units.
    const variantIds = [...new Set(order.items.map((i) => i.variantId))]
    const variants = await tx.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: {
        id: true,
        fulfillmentType: true,
        product: { select: { fulfillmentType: true } },
        stockUnit: { select: { factor: true } },
      },
    })
    const byId = new Map(variants.map((v) => [v.id, v]))

    // Each consumption row snapshots its moving-average cost; we total the
    // positive COGS from those exact snapshots to emit CogsRecorded once (§4.3).
    const cogsLines: CogsLine[] = []

    for (const line of order.items) {
      const variant = byId.get(line.variantId)
      if (!variant) continue
      const fulfillment = variant.fulfillmentType ?? variant.product.fulfillmentType

      if (fulfillment === 'STOCKED') {
        // Deduct the variant itself. Its stock unit's factor converts the sell
        // count into scaled base units; a STOCKED item's sell unit IS its stock
        // unit in practice, so one factor suffices.
        const factor = variant.stockUnit?.factor
        if (!factor) continue // no stock unit → nothing to track
        const qtyBase = toBaseScaled(BigInt(line.qty) * UNIT_FACTOR_SCALE, factor)
        const movement = await this.stock.recordMovement(tx, {
          outletId: order.outletId,
          variantId: variant.id,
          type: 'SALE_CONSUMPTION',
          qtyBaseScaled: -qtyBase,
          refType: 'order',
          refId: order.id,
          ...(userId !== undefined ? { userId } : {}),
        })
        cogsLines.push({ variantId: variant.id, qtyBaseScaled: -qtyBase, cost: -movement.extendedCost })
      } else if (fulfillment === 'MADE_TO_ORDER' && recipeEnabled) {
        // Explode the recipe to base ingredients and deduct each. The graph
        // loader normalises component quantities to per one finished base unit,
        // so the multiplier is the plain sold quantity in scaled base units.
        const graph = await this.recipes.loadGraph(tx, variant.id)
        if (graph.size === 0) continue // MADE_TO_ORDER with no recipe → nothing
        const requirements = explodeRecipe(variant.id, BigInt(line.qty) * UNIT_FACTOR_SCALE, graph)
        for (const req of requirements) {
          const movement = await this.stock.recordMovement(tx, {
            outletId: order.outletId,
            variantId: req.variantId,
            type: 'SALE_CONSUMPTION',
            qtyBaseScaled: -req.qtyBaseScaled,
            refType: 'order',
            refId: order.id,
            ...(userId !== undefined ? { userId } : {}),
          })
          cogsLines.push({
            variantId: req.variantId,
            qtyBaseScaled: -req.qtyBaseScaled,
            cost: -movement.extendedCost,
          })
        }
      }
      // SERVICE, or MADE_TO_ORDER with recipe off / no recipe: consumes nothing.
    }

    // COGS event to Accounting (§4.3, §8.2). One event per order, only when
    // something was actually consumed — the outbox keeps it in the same tx as
    // the deductions (standard #4); Accounting is idempotent on the event id.
    if (cogsLines.length > 0) {
      const ctx = requireTenantContext()
      const totalCost = cogsLines.reduce((sum, l) => sum + l.cost, 0n)
      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: order.outletId,
        type: EVENT_TYPES.COGS_RECORDED,
        payload: {
          orderId: order.id,
          outletId: order.outletId,
          point,
          totalCost,
          lines: cogsLines.map((l) => ({
            variantId: l.variantId,
            qtyBaseScaled: l.qtyBaseScaled,
            cost: l.cost,
          })),
        },
      })
    }
  }
}
