/**
 * Table state machine — S7-02, standard #6 / design §5.4.
 *
 * The single source of transition truth for a table's occupancy. Declared as
 * data through `defineStateMachine`, so `TableService` never hand-rolls a
 * `switch` and an illegal move throws `IllegalTransitionError` (→ 409).
 *
 * Unlike the order machine, a table has NO terminal state — it lives for the
 * life of the outlet and cycles through occupancy. The edges reflect the two
 * drivers of a table's status:
 *
 *   - the order lifecycle: seating an order flips EMPTY/RESERVED → OCCUPIED;
 *     closing or voiding it flips OCCUPIED → DIRTY (needs bussing) or back to
 *     EMPTY;
 *   - manual floor actions: a host reserves an EMPTY table, or a server marks a
 *     DIRTY table clean once bussed.
 *
 * States (design §5.4):
 *
 *   EMPTY    — available to seat. The initial state of a new table.
 *   OCCUPIED — has an active order (§5.4: at most one, enforced by the partial
 *              unique index orders_one_per_table).
 *   RESERVED — booked ahead; held for an arriving guest.
 *   DIRTY    — vacated, awaiting bussing before it can be seated again.
 */

import { defineStateMachine, type StateMachine } from '@brewsync/shared'

/** Mirrors the Prisma `TableStatus` enum; a string union so the machine is DB-free. */
export type TableStatus = 'EMPTY' | 'OCCUPIED' | 'RESERVED' | 'DIRTY'

export const tableStateMachine: StateMachine<TableStatus> = defineStateMachine<TableStatus>({
  name: 'Table',
  initial: 'EMPTY',
  transitions: {
    // Seat, reserve ahead, or mark dirty manually (e.g. a spill before service).
    EMPTY: ['OCCUPIED', 'RESERVED', 'DIRTY'],
    // Order closes → bus it (DIRTY); or clear straight to EMPTY (e.g. voided).
    OCCUPIED: ['DIRTY', 'EMPTY'],
    // Guest arrives (seat) or the booking is cancelled / a no-show.
    RESERVED: ['OCCUPIED', 'EMPTY'],
    // Bussed and ready again.
    DIRTY: ['EMPTY'],
  },
})

/** A table can hold an active order only while OCCUPIED (§5.4). */
export const canSeatOrder = (status: TableStatus): boolean => status === 'OCCUPIED'
