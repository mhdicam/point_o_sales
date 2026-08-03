/**
 * Reservation state machine — S8-01, standard #6 / design §15.1.
 *
 * The single source of transition truth for a booking. Declared as data through
 * `defineStateMachine`, so `ReservationService` never hand-rolls a `switch` and
 * an illegal move throws `IllegalTransitionError` (→ 409) rather than being
 * silently accepted.
 *
 * One model, two faces (§15): F&B books a table (+ arrival time), Service books
 * a slot + staff. The lifecycle is identical — only *what* is reserved differs,
 * which is data, not a code branch.
 *
 * States (design §15.1):
 *
 *   REQUESTED — came in from a customer (online) or was raised by staff; a place
 *               is not yet guaranteed. The initial state.
 *   CONFIRMED — the outlet has confirmed the slot/table. If a deposit applies it
 *               is taken here (§15.3, via the Payment path).
 *   SEATED    — the guest arrived; the reservation is linked to a new Order and
 *               the table flips OCCUPIED (F&B) / the item lands on the board at
 *               its slot (service).
 *   COMPLETED — done (the order closed). Terminal.
 *   NO_SHOW   — confirmed but the guest never arrived past the tolerance window;
 *               a deposit may be forfeited per policy. Terminal.
 *   CANCELLED — cancelled by customer or staff before seating. Terminal.
 *
 * NO_SHOW is reachable only from CONFIRMED — you cannot no-show a booking that
 * was never confirmed, nor one already seated. CANCELLED is reachable from
 * REQUESTED / CONFIRMED: a booking can be called off right up until the guest is
 * seated, after which the exit is COMPLETED (the order takes over), never a
 * cancel of the reservation.
 */

import { defineStateMachine, type StateMachine } from '@brewsync/shared'

/** Mirrors the Prisma `ReservationStatus` enum; a string union keeps the machine DB-free. */
export type ReservationStatus =
  | 'REQUESTED'
  | 'CONFIRMED'
  | 'SEATED'
  | 'COMPLETED'
  | 'NO_SHOW'
  | 'CANCELLED'

export const reservationStateMachine: StateMachine<ReservationStatus> =
  defineStateMachine<ReservationStatus>({
    name: 'Reservation',
    initial: 'REQUESTED',
    transitions: {
      REQUESTED: ['CONFIRMED', 'CANCELLED'],
      CONFIRMED: ['SEATED', 'NO_SHOW', 'CANCELLED'],
      SEATED: ['COMPLETED'],
      COMPLETED: [],
      NO_SHOW: [],
      CANCELLED: [],
    },
  })

/**
 * A reservation holds a table/slot (blocking double-booking, §15.3) only while
 * CONFIRMED. REQUESTED is a tentative ask; SEATED has already handed off to an
 * order; the terminal states hold nothing.
 */
export const holdsResource = (status: ReservationStatus): boolean => status === 'CONFIRMED'
