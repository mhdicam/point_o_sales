/**
 * Reservation service — S8-01/02/03/04, design §15.
 *
 * Orchestrates the booking lifecycle. Transition truth lives in
 * `reservation.state.ts` (standard #6); this service composes it with the table
 * resource, the outbox (standard #4) and — at seating — `OrderService`. Tenant
 * scoping is the Prisma extension's job (standard #1): no `where: { tenantId }`
 * appears here. Every mutation runs in `withTenantTransaction` so the RLS GUC is
 * bound and all reads/writes go through `tx`.
 *
 * The subtle rules, all from the design:
 *
 *   1. Anti double-book (§15.3, S8-02). A table cannot hold two CONFIRMED
 *      reservations whose time windows overlap. The check runs at `confirm` —
 *      the moment the resource is actually held (`holdsResource`) — not at
 *      request time, so tentative REQUESTED bookings can freely overlap. The
 *      window is `[reservedFor, reservedFor + durationMin)`; a booking with no
 *      duration is treated as a point-plus-default occupancy so two same-instant
 *      bookings still collide.
 *
 *   2. Deposit via the Payment path (§15.3, S8-03). A deposit is not a separate
 *      cash model — it is recorded as intent (`depositAmount`) here and, when the
 *      booking seats, carried onto the resulting order as a credit line the
 *      cashier settles through the normal §7 bill/payment flow. This service
 *      never writes a `Payment` row directly (there is no bill yet at CONFIRMED).
 *
 *   3. Seated → floor (§15.3, S8-04). Seating creates an `Order` (via
 *      `OrderService`, so the table flips OCCUPIED through the one seat seam and
 *      the one-order-per-table index guards it) and links `orderId` back onto the
 *      reservation. The order's channel is the booking's origin: a staff booking
 *      opens a STAFF order, an online booking an ONLINE one.
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
import { IllegalTransitionError, EVENT_TYPES } from '@brewsync/shared'
import { badRequest, conflict, notFound } from '../http-error.js'
import {
  reservationStateMachine,
  holdsResource,
  type ReservationStatus,
} from './reservation.state.js'
import { OrderService } from './order.service.js'

type Tx = Prisma.TransactionClient

/** Default table occupancy (minutes) when a booking declares no `durationMin`. */
const DEFAULT_OCCUPANCY_MIN = 120

export type ReservationSource = 'STAFF' | 'ONLINE'

export interface CreateReservationInput {
  outletId: string
  source?: ReservationSource
  customerName: string
  customerPhone: string
  customerEmail?: string | null
  partySize: number
  reservedFor: Date
  durationMin?: number | null
  /** Table promised now (optional; can be auto-assigned at seat). */
  tableId?: string | null
  /** Staff/resource assigned (service vertical). */
  assignedStaffId?: string | null
  /** Deposit intent, minor units (§15.3). Settled through the order at seat. */
  depositAmount?: bigint | null
  notes?: string | null
}

export interface UpdateReservationInput {
  customerName?: string
  customerPhone?: string
  customerEmail?: string | null
  partySize?: number
  reservedFor?: Date
  durationMin?: number | null
  tableId?: string | null
  assignedStaffId?: string | null
  depositAmount?: bigint | null
  notes?: string | null
}

export class ReservationService {
  constructor(private readonly db: BrewsyncClient) {}

  /** Raises a booking in REQUESTED. No resource is held yet (§15.1). */
  async create(input: CreateReservationInput) {
    this.assertPartySize(input.partySize)
    this.assertDuration(input.durationMin)
    this.assertDeposit(input.depositAmount)
    const ctx = requireTenantContext()

    return this.inTx(async (tx) => {
      await this.requireOutlet(tx, input.outletId)
      if (input.tableId) await this.requireTable(tx, input.tableId, input.outletId)

      const reservation = await tx.reservation.create({
        data: {
          tenantId: ctx.tenantId,
          outletId: input.outletId,
          source: input.source ?? 'STAFF',
          status: 'REQUESTED',
          customerName: input.customerName.trim(),
          customerPhone: input.customerPhone.trim(),
          customerEmail: this.orNull(input.customerEmail),
          partySize: input.partySize,
          reservedFor: input.reservedFor,
          durationMin: input.durationMin ?? null,
          tableId: input.tableId ?? null,
          assignedStaffId: input.assignedStaffId ?? null,
          depositAmount: input.depositAmount ?? null,
          notes: this.orNull(input.notes),
          createdByUserId: ctx.userId ?? null,
        } as unknown as Prisma.ReservationCreateInput,
        select: { id: true },
      })
      return this.load(tx, reservation.id)
    })
  }

  /** Reads one booking. */
  async getById(reservationId: string) {
    const reservation = await this.load(this.db as unknown as Tx, reservationId)
    if (!reservation) {
      throw notFound('RESERVATION_NOT_FOUND', `Reservation ${reservationId} not found.`)
    }
    return reservation
  }

  /** Lists bookings for an outlet, soonest arrival first. */
  async list(opts: { outletId?: string; status?: ReservationStatus; tableId?: string } = {}) {
    return this.db.reservation.findMany({
      where: {
        ...(opts.outletId ? { outletId: opts.outletId } : {}),
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.tableId ? { tableId: opts.tableId } : {}),
      },
      orderBy: { reservedFor: 'asc' },
    })
  }

  /** Edits a still-mutable booking (REQUESTED/CONFIRMED). Terminal/seated are frozen. */
  async update(reservationId: string, input: UpdateReservationInput) {
    if (input.partySize !== undefined) this.assertPartySize(input.partySize)
    if (input.durationMin !== undefined) this.assertDuration(input.durationMin)
    if (input.depositAmount !== undefined) this.assertDeposit(input.depositAmount)

    return this.inTx(async (tx) => {
      const reservation = await this.requireReservation(tx, reservationId)
      if (reservation.status !== 'REQUESTED' && reservation.status !== 'CONFIRMED') {
        throw conflict(
          'RESERVATION_NOT_EDITABLE',
          `Reservation is ${reservation.status}; it can only be edited while REQUESTED or CONFIRMED.`
        )
      }
      if (input.tableId) await this.requireTable(tx, input.tableId, reservation.outletId)

      // A held (CONFIRMED) booking that moves its table/time must re-clear the
      // overlap check against the new window (S8-02).
      const nextTableId = input.tableId !== undefined ? input.tableId : reservation.tableId
      const nextReservedFor = input.reservedFor ?? reservation.reservedFor
      const nextDuration = input.durationMin !== undefined ? input.durationMin : reservation.durationMin
      if (holdsResource(reservation.status) && nextTableId) {
        await this.assertNoOverlap(tx, {
          reservationId,
          tableId: nextTableId,
          reservedFor: nextReservedFor,
          durationMin: nextDuration,
        })
      }

      await tx.reservation.update({
        where: { id: reservationId },
        data: {
          ...(input.customerName !== undefined ? { customerName: input.customerName.trim() } : {}),
          ...(input.customerPhone !== undefined ? { customerPhone: input.customerPhone.trim() } : {}),
          ...(input.customerEmail !== undefined ? { customerEmail: this.orNull(input.customerEmail) } : {}),
          ...(input.partySize !== undefined ? { partySize: input.partySize } : {}),
          ...(input.reservedFor !== undefined ? { reservedFor: input.reservedFor } : {}),
          ...(input.durationMin !== undefined ? { durationMin: input.durationMin } : {}),
          ...(input.tableId !== undefined ? { tableId: input.tableId } : {}),
          ...(input.assignedStaffId !== undefined ? { assignedStaffId: input.assignedStaffId } : {}),
          ...(input.depositAmount !== undefined ? { depositAmount: input.depositAmount } : {}),
          ...(input.notes !== undefined ? { notes: this.orNull(input.notes) } : {}),
        },
      })
      return this.load(tx, reservationId)
    })
  }

  /**
   * Confirms a booking. REQUESTED → CONFIRMED — the moment the table/slot is held
   * (§15.1). Runs the anti double-book check (§15.3, S8-02): a table cannot hold
   * two CONFIRMED reservations with overlapping windows. Emits ReservationConfirmed
   * in the same transaction (standard #4).
   */
  async confirm(reservationId: string) {
    const ctx = requireTenantContext()
    return this.inTx(async (tx) => {
      const reservation = await this.requireReservation(tx, reservationId)
      this.assertTransition(reservation.status, 'CONFIRMED')

      // A held booking must claim a concrete table window; overlap is checked
      // against every OTHER CONFIRMED reservation on that table (S8-02).
      if (reservation.tableId) {
        await this.assertNoOverlap(tx, {
          reservationId,
          tableId: reservation.tableId,
          reservedFor: reservation.reservedFor,
          durationMin: reservation.durationMin,
        })
      }

      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      })

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: reservation.outletId,
        type: EVENT_TYPES.RESERVATION_CONFIRMED,
        payload: {
          reservationId,
          tableId: reservation.tableId,
          reservedFor: reservation.reservedFor.toISOString(),
          depositAmount: reservation.depositAmount?.toString() ?? null,
        },
      })
      return this.load(tx, reservationId)
    })
  }

  /**
   * Seats the guest. CONFIRMED → SEATED (§15.3, S8-04). Opens an `Order` for the
   * booking's table through `OrderService` — which flips the table OCCUPIED via
   * the one seat seam and trips the one-order-per-table index on a clash — links
   * `orderId` back onto the reservation, and stamps `seatedAt`. A deposit rides
   * onto the order as an order-level discount credit so the cashier settles the
   * remainder through the normal §7 flow. Emits ReservationSeated.
   *
   * A table id is required to seat (auto-assign happens by editing `tableId`
   * first): the booking must know where the guest sits.
   */
  async seat(reservationId: string) {
    const ctx = requireTenantContext()
    return this.inTx(async (tx) => {
      const reservation = await this.requireReservation(tx, reservationId)
      this.assertTransition(reservation.status, 'SEATED')
      if (!reservation.tableId) {
        throw badRequest('RESERVATION_NO_TABLE', 'Assign a table before seating the reservation.')
      }

      // Open the floor order via the one order seam (seats the table, guards the
      // one-order-per-table index). Reuse THIS transaction — the tx-accepting core
      // avoids nesting a second `$transaction`. Channel mirrors the booking's origin.
      const orderChannel = reservation.source === 'ONLINE' ? 'ONLINE' : 'STAFF'
      const orderSvc = new OrderService(this.db)
      const order = await orderSvc.createInTx(tx, {
        outletId: reservation.outletId,
        channel: orderChannel,
        tableId: reservation.tableId,
      })
      if (!order) {
        throw conflict('RESERVATION_SEAT_FAILED', 'Could not open an order for the reservation.')
      }

      // Carry a deposit onto the new order as a credit the cashier applies against
      // the bill (§15.3) — settled through the normal payment path, not here.
      if (reservation.depositAmount && reservation.depositAmount > 0n) {
        await orderSvc.applyOrderDiscountInTx(tx, order.id, {
          label: 'Deposit',
          amountMinor: reservation.depositAmount,
        })
      }

      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'SEATED', seatedAt: new Date(), orderId: order.id },
      })

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: reservation.outletId,
        type: EVENT_TYPES.RESERVATION_SEATED,
        payload: {
          reservationId,
          orderId: order.id,
          tableId: reservation.tableId,
        },
      })
      return this.load(tx, reservationId)
    })
  }

  /**
   * Marks a confirmed booking a no-show. CONFIRMED → NO_SHOW (§15.1). A deposit,
   * if taken, is handled per policy by the ReservationNoShow consumer (forfeit =
   * still recorded as revenue via the event, standard #4) — this service only
   * records the transition and emits.
   */
  async noShow(reservationId: string) {
    const ctx = requireTenantContext()
    return this.inTx(async (tx) => {
      const reservation = await this.requireReservation(tx, reservationId)
      this.assertTransition(reservation.status, 'NO_SHOW')

      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'NO_SHOW' },
      })

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: reservation.outletId,
        type: EVENT_TYPES.RESERVATION_NO_SHOW,
        payload: {
          reservationId,
          depositAmount: reservation.depositAmount?.toString() ?? null,
        },
      })
      return this.load(tx, reservationId)
    })
  }

  /**
   * Cancels a booking before seating. REQUESTED/CONFIRMED → CANCELLED (§15.1).
   * Emits ReservationCancelled so a deposit-refund policy can act on it.
   */
  async cancel(reservationId: string, reason?: string) {
    const ctx = requireTenantContext()
    const trimmed = reason?.trim() || null
    return this.inTx(async (tx) => {
      const reservation = await this.requireReservation(tx, reservationId)
      this.assertTransition(reservation.status, 'CANCELLED')

      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'CANCELLED', notes: this.appendReason(reservation.notes, trimmed) },
      })

      await emitEvent(tx as unknown as OutboxCapableTx, {
        tenantId: ctx.tenantId,
        outletId: reservation.outletId,
        type: EVENT_TYPES.RESERVATION_CANCELLED,
        payload: {
          reservationId,
          reason: trimmed,
          depositAmount: reservation.depositAmount?.toString() ?? null,
        },
      })
      return this.load(tx, reservationId)
    })
  }

  /* ---------------------------------------------------------------- internals */

  private inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.db as unknown as PrismaClient, fn)
  }

  /**
   * Anti double-book (§15.3, S8-02). Rejects if the given window overlaps any
   * OTHER CONFIRMED reservation on the same table. Windows are half-open
   * `[start, end)`, so a booking that ends exactly when another begins does NOT
   * collide (back-to-back seatings are legal). A booking with no duration uses
   * `DEFAULT_OCCUPANCY_MIN`, so two same-instant bookings still collide.
   */
  private async assertNoOverlap(
    tx: Tx,
    input: { reservationId: string; tableId: string; reservedFor: Date; durationMin: number | null }
  ): Promise<void> {
    const start = input.reservedFor
    const end = this.windowEnd(input.reservedFor, input.durationMin)

    // Only CONFIRMED bookings hold the table; fetch the rest on this table and
    // test each window in memory (the set per table/day is tiny).
    const others = await tx.reservation.findMany({
      where: {
        tableId: input.tableId,
        status: 'CONFIRMED',
        id: { not: input.reservationId },
      },
      select: { id: true, reservedFor: true, durationMin: true },
    })
    for (const other of others) {
      const otherStart = other.reservedFor
      const otherEnd = this.windowEnd(other.reservedFor, other.durationMin)
      // Half-open overlap test: start < otherEnd && otherStart < end.
      if (start < otherEnd && otherStart < end) {
        throw conflict(
          'RESERVATION_OVERLAP',
          'That table already has a confirmed reservation overlapping this time window.'
        )
      }
    }
  }

  /** End of a booking's occupancy window; falls back to the default duration. */
  private windowEnd(start: Date, durationMin: number | null): Date {
    const minutes = durationMin && durationMin > 0 ? durationMin : DEFAULT_OCCUPANCY_MIN
    return new Date(start.getTime() + minutes * 60_000)
  }

  private async load(client: Tx, reservationId: string) {
    return client.reservation.findUnique({
      where: { id: reservationId },
      include: { table: { select: { id: true, name: true, status: true } } },
    })
  }

  private async requireReservation(tx: Tx, reservationId: string) {
    const reservation = await tx.reservation.findUnique({
      where: { id: reservationId },
      select: {
        id: true,
        status: true,
        outletId: true,
        source: true,
        tableId: true,
        reservedFor: true,
        durationMin: true,
        depositAmount: true,
        orderId: true,
        notes: true,
      },
    })
    if (!reservation) {
      throw notFound('RESERVATION_NOT_FOUND', `Reservation ${reservationId} not found.`)
    }
    return {
      ...reservation,
      status: reservation.status as ReservationStatus,
      source: reservation.source as ReservationSource,
    }
  }

  private async requireOutlet(tx: Tx, outletId: string): Promise<void> {
    const outlet = await tx.outlet.findUnique({ where: { id: outletId }, select: { id: true } })
    if (!outlet) throw notFound('OUTLET_NOT_FOUND', `Outlet ${outletId} not found.`)
  }

  /** A promised table must exist and belong to this booking's outlet. */
  private async requireTable(tx: Tx, tableId: string, outletId: string): Promise<void> {
    const table = await tx.table.findUnique({
      where: { id: tableId },
      select: { id: true, outletId: true },
    })
    if (!table) throw notFound('TABLE_NOT_FOUND', `Table ${tableId} not found.`)
    if (table.outletId !== outletId) {
      throw badRequest('TABLE_WRONG_OUTLET', 'The table belongs to another outlet.')
    }
  }

  private assertPartySize(partySize: number): void {
    if (!Number.isInteger(partySize) || partySize <= 0) {
      throw badRequest('INVALID_PARTY_SIZE', 'Party size must be a positive integer.')
    }
  }

  private assertDuration(durationMin: number | null | undefined): void {
    if (durationMin === null || durationMin === undefined) return
    if (!Number.isInteger(durationMin) || durationMin <= 0) {
      throw badRequest('INVALID_DURATION', 'Duration must be a positive integer of minutes.')
    }
  }

  private assertDeposit(depositAmount: bigint | null | undefined): void {
    if (depositAmount === null || depositAmount === undefined) return
    if (depositAmount < 0n) {
      throw badRequest('INVALID_DEPOSIT', 'Deposit amount cannot be negative.')
    }
  }

  private assertTransition(from: ReservationStatus, to: ReservationStatus): void {
    try {
      reservationStateMachine.assert(from, to)
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        throw conflict('ILLEGAL_TRANSITION', err.message)
      }
      throw err
    }
  }

  private orNull(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }

  /** Threads a cancellation reason into the notes field without losing prior notes. */
  private appendReason(existing: string | null, reason: string | null): string | null {
    if (!reason) return existing
    const tag = `Cancelled: ${reason}`
    return existing ? `${existing}\n${tag}` : tag
  }
}
