import { describe, it, expect } from 'vitest'
import { defineStateMachine, IllegalTransitionError } from './state-machine.js'

// Mirrors the Order machine from design §5.1, which S4 will consume directly.
const orderMachine = defineStateMachine({
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
} as const)

describe('defineStateMachine', () => {
  it('allows declared transitions', () => {
    expect(orderMachine.can('OPEN', 'SENT')).toBe(true)
    expect(orderMachine.can('BILLED', 'PAID')).toBe(true)
  })

  it('refuses to skip states', () => {
    expect(orderMachine.can('OPEN', 'PAID')).toBe(false)
    expect(orderMachine.can('OPEN', 'CLOSED')).toBe(false)
  })

  it('refuses to move backwards', () => {
    expect(orderMachine.can('PAID', 'OPEN')).toBe(false)
    expect(orderMachine.can('SERVED', 'SENT')).toBe(false)
  })

  it('throws a descriptive error on an illegal transition', () => {
    expect(() => orderMachine.assert('OPEN', 'PAID')).toThrow(IllegalTransitionError)
    expect(() => orderMachine.assert('OPEN', 'PAID')).toThrow(/Allowed from OPEN: SENT, VOID/)
  })

  it('treats terminal states as terminal', () => {
    expect(orderMachine.isTerminal('CLOSED')).toBe(true)
    expect(orderMachine.isTerminal('VOID')).toBe(true)
    expect(orderMachine.isTerminal('OPEN')).toBe(false)
    expect(() => orderMachine.assert('CLOSED', 'OPEN')).toThrow(/terminal state/)
  })

  it('allows VOID from every pre-payment state (design §5.1)', () => {
    for (const from of ['OPEN', 'SENT', 'SERVED', 'BILLED'] as const) {
      expect(orderMachine.can(from, 'VOID')).toBe(true)
    }
  })

  it('does not allow VOID after payment — that path is a refund', () => {
    expect(orderMachine.can('PAID', 'VOID')).toBe(false)
  })

  it('carries structured context on the error for the API layer', () => {
    try {
      orderMachine.assert('PAID', 'OPEN')
      expect.unreachable('should have thrown')
    } catch (err) {
      const e = err as IllegalTransitionError
      expect(e.code).toBe('ILLEGAL_TRANSITION')
      expect(e.machine).toBe('Order')
      expect(e.from).toBe('PAID')
      expect(e.to).toBe('OPEN')
      expect(e.allowed).toEqual(['CLOSED'])
    }
  })

  it('rejects a machine naming an undeclared target state', () => {
    expect(() =>
      defineStateMachine({
        name: 'Broken',
        initial: 'A',
        transitions: { A: ['B'] } as Record<'A', readonly 'A'[]>,
      })
    ).toThrow(/undeclared state/)
  })
})
