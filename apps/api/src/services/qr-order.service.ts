/**
 * QR self-service order flow — S8-06, design §16.2.
 *
 * A customer scans a QR printed on a table; its URL carries the table's
 * `qrToken` (random, globally unique, generated at table-create in S8-05). This
 * service is the seam between a public, unauthenticated request and the tenant
 * world:
 *
 *   1. `resolveTable(token)` is the ONE place a client string maps to a tenant.
 *      It reads through the system client (`brewsync_system`, BYPASSRLS) because
 *      no tenant context exists yet and the RLS-subject app client returns zero
 *      rows without a bound GUC. Everything downstream uses the *resolved*
 *      tenant/outlet/table ids — never client input — which is why a public
 *      write here is not an escalation hole.
 *   2. `menu(resolved)` and `placeOrder(resolved, items)` bind that resolved
 *      context via `runWithTenantContext` / `withTenantTransaction`, so the
 *      Prisma extension + RLS scope every read and write exactly as for a staff
 *      request.
 *
 * The order lands as `channel = QR_TABLE` and drops into the same Order state
 * machine, bill pipeline (§6), KDS (§5.5) and events (§8) as a staff order —
 * only the origin differs (§16.4). Per §16.2 the outlet chooses between
 * auto-accept (order is sent to the kitchen immediately) and staff-approve
 * (order stays OPEN until a waiter accepts it via the existing `send` action) —
 * driven by `Outlet.qrAutoAccept`. No new order state is introduced.
 *
 * A not-found or inactive token yields an opaque `QR_INVALID` (404) — the same
 * message whether the token never existed, was rotated away, or the outlet
 * simply has QR ordering disabled — so nothing about tenant structure leaks.
 */

import {
  type BrewsyncClient,
  type PrismaClient,
  type OutboxCapableTx,
  type Prisma,
  runWithTenantContext,
  withTenantTransaction,
  emitEvent,
} from '@brewsync/db'
import { EVENT_TYPES } from '@brewsync/shared'
import { notFound } from '../http-error.js'
import { FeatureService } from './feature.service.js'
import { ProductService } from './product.service.js'
import { PriceService } from './price.service.js'
import { OrderService, type OrderItemInput } from './order.service.js'
import type { SystemClient } from '../system-client.js'

type Tx = Prisma.TransactionClient

/** A table resolved from its QR token — the trusted ids every downstream op uses. */
export interface ResolvedTable {
  tenantId: string
  outletId: string
  tableId: string
  tableName: string
}

export class QrOrderService {
  constructor(
    private readonly db: BrewsyncClient,
    private readonly system: SystemClient
  ) {}

  /**
   * Maps a QR token to its table. Runs on the system client (`brewsync_system`,
   * BYPASSRLS): the token is globally unique, so no tenant context is needed — or
   * available — yet, and the app client's RLS would return zero rows without a
   * bound GUC. The resolved ids feed every downstream op — never client input. A
   * missing/inactive table throws the opaque `QR_INVALID`; the caller never
   * learns why.
   */
  async resolveTable(qrToken: string): Promise<ResolvedTable> {
    const table = await this.system.table.findUnique({
      where: { qrToken },
      select: { id: true, name: true, isActive: true, tenantId: true, outletId: true },
    })
    if (!table || !table.isActive) {
      throw notFound('QR_INVALID', 'This QR code is not valid.')
    }
    return {
      tenantId: table.tenantId,
      outletId: table.outletId,
      tableId: table.id,
      tableName: table.name,
    }
  }

  /**
   * The dine-in menu for a resolved table: the outlet's active catalog with a
   * resolved price per variant. Binds the resolved tenant/outlet context, then
   * asserts `qrOrder` is on (else opaque `QR_INVALID`, so a disabled toggle does
   * not leak). Reads are scoped normally by the extension once context is bound.
   */
  async menu(resolved: ResolvedTable) {
    return runWithTenantContext({ tenantId: resolved.tenantId, outletId: resolved.outletId }, async () => {
      await this.assertQrEnabled(this.db)

      const products = await new ProductService(this.db).list()
      const priceSvc = new PriceService(this.db)

      // Flatten to variants so the customer sees purchasable rows with prices
      // resolved for this outlet (salesMethod null → outlet/global price lists,
      // same as a dine-in staff order created without an explicit method).
      const categories = products.map((p) => ({
        productId: p.id,
        name: p.name,
        categoryName: p.category?.name ?? null,
        coverImageUrl: p.images[0]?.url ?? null,
      }))

      const variants = await this.db.productVariant.findMany({
        where: { product: { isActive: true }, isActive: true },
        select: { id: true, productId: true, name: true, basePrice: true },
        orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
      })
      const prices = await priceSvc.resolveMany(
        variants.map((v) => v.id),
        { outletId: resolved.outletId, salesMethod: null }
      )

      const menu = variants.map((v) => ({
        variantId: v.id,
        productId: v.productId,
        name: v.name,
        // Price is minor units; serialise BigInt to string for JSON transport.
        price: (prices.get(v.id)?.price ?? v.basePrice).toString(),
      }))

      return { products: categories, variants: menu }
    })
  }

  /**
   * Places a QR order. Binds the resolved context, then in one transaction:
   * asserts `qrOrder`, opens the order at `channel = QR_TABLE` on the resolved
   * table (the `createInTx` seam flips the table OCCUPIED and enforces
   * one-active-order-per-table), emits `OrderCreated`, and — when the outlet
   * auto-accepts — sends it to the kitchen in the SAME transaction via
   * `sendInTx`. Returns the order plus whether it was accepted.
   */
  async placeOrder(resolved: ResolvedTable, items: OrderItemInput[]) {
    return runWithTenantContext(
      { tenantId: resolved.tenantId, outletId: resolved.outletId },
      () =>
        withTenantTransaction(this.db as unknown as PrismaClient, async (tx) => {
          await this.assertQrEnabled(tx)

          const outlet = await tx.outlet.findUnique({
            where: { id: resolved.outletId },
            select: { qrAutoAccept: true },
          })
          if (!outlet) throw notFound('QR_INVALID', 'This QR code is not valid.')

          const orderSvc = new OrderService(this.db)
          const order = await orderSvc.createInTx(tx, {
            outletId: resolved.outletId,
            channel: 'QR_TABLE',
            tableId: resolved.tableId,
            salesMethod: null,
            items,
          })
          if (!order) {
            throw notFound('QR_INVALID', 'This QR code is not valid.')
          }

          // A customer channel emits OrderCreated so staff (or the KDS incoming
          // lane) can see the pending order — regardless of auto-accept mode.
          await emitEvent(tx as unknown as OutboxCapableTx, {
            tenantId: resolved.tenantId,
            outletId: resolved.outletId,
            type: EVENT_TYPES.ORDER_CREATED,
            payload: { orderId: order.id, channel: 'QR_TABLE', tableId: resolved.tableId },
          })

          // Auto-accept: send in the same tx via the tx-accepting core so we
          // don't nest a second `$transaction`. Staff-approve leaves it OPEN for
          // a waiter to accept through the normal authenticated `send`.
          if (outlet.qrAutoAccept) {
            const sent = await orderSvc.sendInTx(tx, order.id)
            return { order: sent, accepted: true }
          }
          return { order, accepted: false }
        })
    )
  }

  /** Asserts `qrOrder` is enabled; a disabled toggle is masked as `QR_INVALID`. */
  private async assertQrEnabled(client: BrewsyncClient | Tx): Promise<void> {
    const enabled = await new FeatureService(client as unknown as BrewsyncClient).isEnabled('qrOrder')
    if (!enabled) {
      throw notFound('QR_INVALID', 'This QR code is not valid.')
    }
  }
}
