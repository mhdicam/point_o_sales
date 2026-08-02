/**
 * S6-06 — PurchaseOrder state machine legality. Standard #6, design §4.5.
 *
 * The machine is the single source of transition truth; this suite pins the
 * legal edges and proves the illegal ones throw rather than being silently
 * accepted. The important negative cases: APPROVED cannot be skipped from
 * SUBMITTED's predecessor (a DRAFT must be SUBMITTED first), and CANCELLED is
 * NOT reachable once goods start arriving (RECEIVING/RECEIVED) — after stock has
 * moved, the reversal is a ledger adjustment (standard #3), never a PO cancel.
 */

import { describe, it, expect } from 'vitest'
import { IllegalTransitionError } from '@brewsync/shared'
import {
  purchaseOrderStateMachine,
  isEditable,
  type PurchaseOrderStatus,
} from '../../src/services/purchase-order.state.js'

const LEGAL: Array<[PurchaseOrderStatus, PurchaseOrderStatus]> = [
  ['DRAFT', 'SUBMITTED'],
  ['DRAFT', 'CANCELLED'],
  ['SUBMITTED', 'APPROVED'],
  ['SUBMITTED', 'CANCELLED'],
  ['APPROVED', 'RECEIVING'],
  ['APPROVED', 'RECEIVED'],
  ['APPROVED', 'CANCELLED'],
  ['RECEIVING', 'RECEIVED'],
  ['RECEIVED', 'CLOSED'],
]

const ILLEGAL: Array<[PurchaseOrderStatus, PurchaseOrderStatus]> = [
  ['DRAFT', 'APPROVED'], // must be SUBMITTED first
  ['DRAFT', 'RECEIVED'],
  ['SUBMITTED', 'RECEIVING'], // must be APPROVED first
  ['APPROVED', 'CLOSED'], // must be RECEIVED first
  ['RECEIVING', 'CANCELLED'], // stock already moving — reverse via the ledger
  ['RECEIVED', 'CANCELLED'],
  ['RECEIVED', 'RECEIVING'], // no going back
  ['CLOSED', 'DRAFT'], // terminal
  ['CANCELLED', 'DRAFT'], // terminal
]

describe('S6-06 — PurchaseOrder state machine', () => {
  it.each(LEGAL)('allows %s → %s', (from, to) => {
    expect(purchaseOrderStateMachine.can(from, to)).toBe(true)
    expect(() => purchaseOrderStateMachine.assert(from, to)).not.toThrow()
  })

  it.each(ILLEGAL)('rejects %s → %s', (from, to) => {
    expect(purchaseOrderStateMachine.can(from, to)).toBe(false)
    expect(() => purchaseOrderStateMachine.assert(from, to)).toThrow(IllegalTransitionError)
  })

  it('treats CLOSED and CANCELLED as terminal', () => {
    expect(purchaseOrderStateMachine.isTerminal('CLOSED')).toBe(true)
    expect(purchaseOrderStateMachine.isTerminal('CANCELLED')).toBe(true)
    expect(purchaseOrderStateMachine.isTerminal('DRAFT')).toBe(false)
  })

  it('is editable only while DRAFT (standard #7)', () => {
    expect(isEditable('DRAFT')).toBe(true)
    for (const s of [
      'SUBMITTED',
      'APPROVED',
      'RECEIVING',
      'RECEIVED',
      'CLOSED',
      'CANCELLED',
    ] as PurchaseOrderStatus[]) {
      expect(isEditable(s)).toBe(false)
    }
  })
})
