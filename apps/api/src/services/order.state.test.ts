/**
 * S4-07 — Order state machine legality. Standard #6, design §7.
 *
 * The machine is the single source of transition truth; this suite pins the
 * legal edges and proves the illegal ones throw rather than being silently
 * accepted. The most important negative case is the last one: VOID is NOT
 * reachable from PAID — once money has changed hands the reversal is a refund
 * (a negative Payment), never a void.
 */

import { describe, it, expect } from 'vitest'
import { IllegalTransitionError } from '@brewsync/shared'
import { orderStateMachine, isEditable, type OrderStatus } from '../../src/services/order.state.js'

const LEGAL: Array<[OrderStatus, OrderStatus]> = [
  ['OPEN', 'SENT'],
  ['OPEN', 'VOID'],
  ['SENT', 'SERVED'],
  ['SENT', 'BILLED'],
  ['SENT', 'VOID'],
  ['SERVED', 'BILLED'],
  ['SERVED', 'VOID'],
  ['BILLED', 'PAID'],
  ['BILLED', 'VOID'],
  ['PAID', 'CLOSED'],
]

const ILLEGAL: Array<[OrderStatus, OrderStatus]> = [
  ['OPEN', 'BILLED'], // must be SENT first
  ['OPEN', 'PAID'],
  ['OPEN', 'SERVED'],
  ['SENT', 'PAID'], // must be BILLED first
  ['SERVED', 'PAID'],
  ['BILLED', 'CLOSED'], // must be PAID first
  ['PAID', 'VOID'], // the refund rule — money taken cannot be voided
  ['PAID', 'BILLED'],
  ['CLOSED', 'OPEN'], // terminal
  ['VOID', 'OPEN'], // terminal
]

describe('S4-07 — Order state machine', () => {
  it.each(LEGAL)('allows %s → %s', (from, to) => {
    expect(orderStateMachine.can(from, to)).toBe(true)
    expect(() => orderStateMachine.assert(from, to)).not.toThrow()
  })

  it.each(ILLEGAL)('rejects %s → %s', (from, to) => {
    expect(orderStateMachine.can(from, to)).toBe(false)
    expect(() => orderStateMachine.assert(from, to)).toThrow(IllegalTransitionError)
  })

  it('treats CLOSED and VOID as terminal', () => {
    expect(orderStateMachine.isTerminal('CLOSED')).toBe(true)
    expect(orderStateMachine.isTerminal('VOID')).toBe(true)
    expect(orderStateMachine.isTerminal('OPEN')).toBe(false)
  })

  it('is editable only while OPEN (standard #7)', () => {
    expect(isEditable('OPEN')).toBe(true)
    for (const s of ['SENT', 'SERVED', 'BILLED', 'PAID', 'CLOSED', 'VOID'] as OrderStatus[]) {
      expect(isEditable(s)).toBe(false)
    }
  })
})
