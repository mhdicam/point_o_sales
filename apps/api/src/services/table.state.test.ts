/**
 * S7-02 — Table state machine legality. Standard #6, design §5.4.
 *
 * The machine is the single source of transition truth; this suite pins the
 * legal edges and proves the illegal ones throw rather than being silently
 * accepted. Unlike the order machine, a table has no terminal state — it lives
 * for the life of the outlet and cycles through occupancy.
 */

import { describe, it, expect } from 'vitest'
import { IllegalTransitionError } from '@brewsync/shared'
import { tableStateMachine, canSeatOrder, type TableStatus } from '../../src/services/table.state.js'

const LEGAL: Array<[TableStatus, TableStatus]> = [
  ['EMPTY', 'OCCUPIED'], // seat a new order
  ['EMPTY', 'RESERVED'], // book ahead
  ['EMPTY', 'DIRTY'], // manual mark (e.g. spill before service)
  ['OCCUPIED', 'DIRTY'], // order closed, needs bussing
  ['OCCUPIED', 'EMPTY'], // voided order, skip bussing
  ['RESERVED', 'OCCUPIED'], // guest arrives, seated
  ['RESERVED', 'EMPTY'], // booking cancelled / no-show
  ['DIRTY', 'EMPTY'], // bussed and ready
]

const ILLEGAL: Array<[TableStatus, TableStatus]> = [
  ['EMPTY', 'EMPTY'], // no-op
  ['OCCUPIED', 'RESERVED'], // can't reserve while seated
  ['OCCUPIED', 'OCCUPIED'], // no-op
  ['RESERVED', 'DIRTY'], // not bussed until occupied
  ['RESERVED', 'RESERVED'], // no-op
  ['DIRTY', 'OCCUPIED'], // must be cleaned first
  ['DIRTY', 'RESERVED'], // must be cleaned first
  ['DIRTY', 'DIRTY'], // no-op
]

describe('S7-02 — Table state machine', () => {
  it.each(LEGAL)('allows %s → %s', (from, to) => {
    expect(tableStateMachine.can(from, to)).toBe(true)
    expect(() => tableStateMachine.assert(from, to)).not.toThrow()
  })

  it.each(ILLEGAL)('rejects %s → %s', (from, to) => {
    expect(tableStateMachine.can(from, to)).toBe(false)
    expect(() => tableStateMachine.assert(from, to)).toThrow(IllegalTransitionError)
  })

  it('has no terminal state (tables cycle)', () => {
    expect(tableStateMachine.isTerminal('EMPTY')).toBe(false)
    expect(tableStateMachine.isTerminal('OCCUPIED')).toBe(false)
    expect(tableStateMachine.isTerminal('RESERVED')).toBe(false)
    expect(tableStateMachine.isTerminal('DIRTY')).toBe(false)
  })

  it('can seat an order only while OCCUPIED (§5.4)', () => {
    expect(canSeatOrder('OCCUPIED')).toBe(true)
    for (const s of ['EMPTY', 'RESERVED', 'DIRTY'] as TableStatus[]) {
      expect(canSeatOrder(s)).toBe(false)
    }
  })
})
