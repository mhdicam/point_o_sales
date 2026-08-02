/**
 * S7-04 — KDS lane state machine unit tests.
 *
 * Legality of the kitchen prep lane (§5.1): forward flow, one-step bump-back, and
 * the two terminal states (SERVED / VOID).
 */

import { describe, it, expect } from 'vitest'
import { IllegalTransitionError } from '@brewsync/shared'
import { kdsStateMachine, type KdsStatus } from '../../src/services/kds.state.js'

describe('S7-04 — KDS lane state machine', () => {
  const legal: [KdsStatus, KdsStatus][] = [
    ['QUEUED', 'PREPARING'],
    ['QUEUED', 'VOID'],
    ['PREPARING', 'READY'],
    ['PREPARING', 'QUEUED'],
    ['PREPARING', 'VOID'],
    ['READY', 'SERVED'],
    ['READY', 'PREPARING'],
  ]

  for (const [from, to] of legal) {
    it(`allows ${from} → ${to}`, () => {
      expect(kdsStateMachine.can(from, to)).toBe(true)
      expect(() => kdsStateMachine.assert(from, to)).not.toThrow()
    })
  }

  const illegal: [KdsStatus, KdsStatus][] = [
    ['QUEUED', 'READY'],
    ['QUEUED', 'SERVED'],
    ['PREPARING', 'SERVED'],
    ['READY', 'QUEUED'],
    ['READY', 'VOID'],
    ['SERVED', 'PREPARING'],
    ['VOID', 'QUEUED'],
  ]

  for (const [from, to] of illegal) {
    it(`rejects ${from} → ${to}`, () => {
      expect(kdsStateMachine.can(from, to)).toBe(false)
      expect(() => kdsStateMachine.assert(from, to)).toThrow(IllegalTransitionError)
    })
  }

  it('treats SERVED and VOID as terminal', () => {
    expect(kdsStateMachine.isTerminal('SERVED')).toBe(true)
    expect(kdsStateMachine.isTerminal('VOID')).toBe(true)
    expect(kdsStateMachine.isTerminal('QUEUED')).toBe(false)
  })

  it('starts at QUEUED', () => {
    expect(kdsStateMachine.initial).toBe('QUEUED')
  })
})
