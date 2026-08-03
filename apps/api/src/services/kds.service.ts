/**
 * KDS service — S7-04/05, design §5.5.
 *
 * Reads the kitchen board and advances a line's prep lane. The board is a pure
 * projection over `OrderItem`: every line with a non-null `kdsStatus` (routed at
 * SENT) that has not reached a terminal lane, grouped by station. No separate KDS
 * table — the order line *is* the ticket (§5.2, the line carries `kdsStatus` +
 * `stationId`).
 *
 * Lane transitions go through the explicit `kdsStateMachine` (standard #6); an
 * illegal move throws `IllegalTransitionError` → 409 at the boundary. Advancing a
 * line to SERVED also settles the order item's own `SERVED`-ness is left to the
 * order flow; the KDS lane is the kitchen's private view and does not mutate the
 * order status here.
 *
 * Realtime (S7-05) layers on top: the board read is the initial paint, and the
 * WebSocket hub pushes lane changes so screens update without polling. This
 * service emits the change through the outbox in the same transaction (standard
 * #4) so the hub is fed from a durable, ordered source.
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
import { conflict, notFound } from '../http-error.js'
import { kdsStateMachine, type KdsStatus } from './kds.state.js'

/** Lanes still shown on the board — terminal lines drop off. */
const ACTIVE_LANES: KdsStatus[] = ['QUEUED', 'PREPARING', 'READY']

export class KdsService {
  constructor(private readonly db: BrewsyncClient) {}

  /**
   * The live board for an outlet: active KDS lines, grouped by station. An
   * unrouted line (station-less MADE_TO_ORDER, §5.5) is returned under a null
   * `stationId` so the UI can surface it rather than lose it.
   */
  async board(outletId: string) {
    const items = await this.db.orderItem.findMany({
      where: {
        kdsStatus: { in: ACTIVE_LANES },
        order: { outletId },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        orderId: true,
        stationId: true,
        kdsStatus: true,
        qty: true,
        nameSnapshot: true,
        modifiersSnapshot: true,
        createdAt: true,
        order: { select: { channel: true, tableId: true } },
      },
    })

    const stations = await this.db.station.findMany({
      where: { outletId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    })

    return { stations, tickets: items }
  }

  /**
   * Advances (or bumps back / voids) one line's lane. Validated through the
   * explicit machine; emits KDS_ITEM_UPDATED in the same transaction so the
   * realtime hub (S7-05) can push it.
   */
  async setStatus(orderItemId: string, to: KdsStatus) {
    const ctx = requireTenantContext()
    return withTenantTransaction(this.db as unknown as PrismaClient, async (tx) => {
      const item = await tx.orderItem.findUnique({
        where: { id: orderItemId },
        select: {
          id: true,
          kdsStatus: true,
          stationId: true,
          order: { select: { outletId: true } },
        },
      })
      if (!item || item.kdsStatus === null) {
        throw notFound('KDS_ITEM_NOT_FOUND', `KDS line ${orderItemId} not found.`)
      }

      const from = item.kdsStatus as KdsStatus
      try {
        kdsStateMachine.assert(from, to)
      } catch (err) {
        if (err instanceof IllegalTransitionError) {
          throw conflict('ILLEGAL_KDS_TRANSITION', err.message)
        }
        throw err
      }

      await tx.orderItem.update({
        where: { id: orderItemId },
        data: { kdsStatus: to } as unknown as Prisma.OrderItemUpdateInput,
      })

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: item.order.outletId,
        type: EVENT_TYPES.KDS_ITEM_UPDATED,
        payload: { orderItemId, stationId: item.stationId, from, to },
      })

      return { id: orderItemId, kdsStatus: to }
    })
  }
}
