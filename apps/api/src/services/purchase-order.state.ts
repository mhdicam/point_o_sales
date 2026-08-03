/**
 * PurchaseOrder state machine — S6-06, standard #6 / design §4.5.
 *
 * The single source of transition truth for a PO. Declared as data through
 * `defineStateMachine`, so `PurchaseOrderService` never hand-rolls a `switch`
 * and an illegal move throws `IllegalTransitionError` (→ 409) rather than being
 * silently accepted.
 *
 * States (design §4.5):
 *
 *   DRAFT      — being drafted; items and quantities are freely editable. The
 *                ONLY editable state.
 *   SUBMITTED  — submitted for approval (who may approve is RBAC's job, §12 —
 *                the `purchase.approve` permission).
 *   APPROVED   — approved and sent to the supplier. Price and qty freeze here
 *                (standard #7): unitCost, lineTotal, and the header totals are
 *                snapshotted and never re-read from master data after.
 *   RECEIVING  — partially received (goods arrive in stages). Declared here but
 *                only driven by the goods-receipt path (S6-07).
 *   RECEIVED   — every line fully received. Driven by S6-07.
 *   CLOSED     — matched (PO vs receipt vs supplier invoice) and done.
 *   CANCELLED  — cancelled with a required reason; terminal.
 *
 * CANCELLED is reachable from DRAFT / SUBMITTED / APPROVED — a mistake can be
 * undone right up until goods start arriving. It is deliberately NOT reachable
 * from RECEIVING / RECEIVED: once stock has physically moved, the reversal is a
 * return/adjustment against the ledger (standard #3), never a cancel of the PO.
 */

import { defineStateMachine, type StateMachine } from '@brewsync/shared'

/** Mirrors the Prisma `PurchaseOrderStatus` enum; a string union keeps the machine DB-free. */
export type PurchaseOrderStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'RECEIVING'
  | 'RECEIVED'
  | 'CLOSED'
  | 'CANCELLED'

export const purchaseOrderStateMachine: StateMachine<PurchaseOrderStatus> =
  defineStateMachine<PurchaseOrderStatus>({
    name: 'PurchaseOrder',
    initial: 'DRAFT',
    transitions: {
      DRAFT: ['SUBMITTED', 'CANCELLED'],
      SUBMITTED: ['APPROVED', 'CANCELLED'],
      APPROVED: ['RECEIVING', 'RECEIVED', 'CANCELLED'],
      RECEIVING: ['RECEIVED'],
      RECEIVED: ['CLOSED'],
      CLOSED: [],
      CANCELLED: [],
    },
  })

/** Editing lines (add/change qty/cost/remove) is legal only while DRAFT (§4.5). */
export const isEditable = (status: PurchaseOrderStatus): boolean => status === 'DRAFT'
