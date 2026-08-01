/**
 * Order state machine — S4-02, standard #6 / design §7.
 *
 * The single source of transition truth for an order. Declared as data through
 * `defineStateMachine`, so `OrderService` never hand-rolls a `switch` and an
 * illegal move throws `IllegalTransitionError` (→ 409) rather than being silently
 * accepted.
 *
 * States (design §7):
 *
 *   OPEN    — being built; items can be added/edited/removed. The ONLY editable
 *             state (§7.1). No snapshots yet.
 *   SENT    — fired to the kitchen/bar; item price/name freeze here (standard #7).
 *             Items are no longer editable.
 *   SERVED  — delivered to the customer. A pass-through book-keeping state; the
 *             bill can be raised from either SENT or SERVED.
 *   BILLED  — the Bill snapshot moment (§7.1); charges freeze. Awaiting payment.
 *   PAID    — settled. SaleCompleted is emitted here (S5, not this sprint).
 *   CLOSED  — terminal happy path.
 *   VOID    — terminal cancelled; reachable from every pre-PAID state so a mistake
 *             can always be undone before money is taken.
 *
 * VOID is deliberately NOT reachable from PAID: once money has changed hands the
 * reversal is a refund (a negative Payment, §7 / standard #3), never a void.
 */

import { defineStateMachine, type StateMachine } from '@brewsync/shared'

/** Mirrors the Prisma `OrderStatus` enum; kept as a string union so the machine is DB-free. */
export type OrderStatus = 'OPEN' | 'SENT' | 'SERVED' | 'BILLED' | 'PAID' | 'CLOSED' | 'VOID'

export const orderStateMachine: StateMachine<OrderStatus> = defineStateMachine<OrderStatus>({
  name: 'Order',
  initial: 'OPEN',
  transitions: {
    OPEN: ['SENT', 'VOID'],
    SENT: ['SERVED', 'BILLED', 'VOID'],
    SERVED: ['BILLED', 'VOID'],
    BILLED: ['PAID', 'VOID'],
    PAID: ['CLOSED'],
    CLOSED: [],
    VOID: [],
  },
})

/** Editing items (add/change qty/remove) is legal only while OPEN (§7.1). */
export const isEditable = (status: OrderStatus): boolean => status === 'OPEN'
