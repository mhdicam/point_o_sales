/**
 * S8-01 — Reservation state machine legality. Standard #6, design §15.1.
 *
 * The machine is the single source of transition truth; this suite pins the
 * legal edges and proves the illegal ones throw rather than being silently
 * accepted. The important negative cases: you cannot NO_SHOW a booking that was
 * never CONFIRMED, cannot CANCEL one already SEATED (the order takes over — the
 * only exit is COMPLETED), and cannot skip CONFIRMED to seat straight from
 * REQUESTED.
 */

import { describe, it, expect } from 'vitest'
import { IllegalTransitionError } from '@brewsync/shared'
import {
  reservationStateMachine,
  holdsResource,
  type ReservationStatus,
} from '../../src/services/reservation.state.js'

const LEGAL: Array<[ReservationStatus, ReservationStatus]> = [
  ['REQUESTED', 'CONFIRMED'],
  ['REQUESTED', 'CANCELLED'],
  ['CONFIRMED', 'SEATED'],
  ['CONFIRMED', 'NO_SHOW'],
  ['CONFIRMED', 'CANCELLED'],
  ['SEATED', 'COMPLETED'],
]

const ILLEGAL: Array<[ReservationStatus, ReservationStatus]> = [
  ['REQUESTED', 'SEATED'], // must be CONFIRMED first
  ['REQUESTED', 'NO_SHOW'], // can only no-show a confirmed booking
  ['REQUESTED', 'COMPLETED'],
  ['CONFIRMED', 'COMPLETED'], // must be SEATED first
  ['SEATED', 'CANCELLED'], // order has taken over — exit is COMPLETED
  ['SEATED', 'NO_SHOW'],
  ['COMPLETED', 'REQUESTED'], // terminal
  ['NO_SHOW', 'CONFIRMED'], // terminal
  ['CANCELLED', 'REQUESTED'], // terminal
]

describe('S8-01 — Reservation state machine', () => {
  it.each(LEGAL)('allows %s → %s', (from, to) => {
    expect(reservationStateMachine.can(from, to)).toBe(true)
    expect(() => reservationStateMachine.assert(from, to)).not.toThrow()
  })

  it.each(ILLEGAL)('rejects %s → %s', (from, to) => {
    expect(reservationStateMachine.can(from, to)).toBe(false)
    expect(() => reservationStateMachine.assert(from, to)).toThrow(IllegalTransitionError)
  })

  it('treats COMPLETED, NO_SHOW and CANCELLED as terminal', () => {
    expect(reservationStateMachine.isTerminal('COMPLETED')).toBe(true)
    expect(reservationStateMachine.isTerminal('NO_SHOW')).toBe(true)
    expect(reservationStateMachine.isTerminal('CANCELLED')).toBe(true)
    expect(reservationStateMachine.isTerminal('REQUESTED')).toBe(false)
    expect(reservationStateMachine.isTerminal('CONFIRMED')).toBe(false)
  })

  it('holds a table/slot only while CONFIRMED (§15.3 double-book guard)', () => {
    expect(holdsResource('CONFIRMED')).toBe(true)
    for (const s of [
      'REQUESTED',
      'SEATED',
      'COMPLETED',
      'NO_SHOW',
      'CANCELLED',
    ] as ReservationStatus[]) {
      expect(holdsResource(s)).toBe(false)
    }
  })
})
