import { describe, expect, it } from 'vitest'
import { isDebit, movementLabel, varianceState } from './shift-view.ts'
import type { CashMovement } from './types.ts'

function movement(over: Partial<CashMovement> = {}): CashMovement {
  return {
    id: 'cm1',
    shiftId: 's1',
    type: 'CASH_SALE',
    amount: '1000',
    refType: null,
    refId: null,
    reason: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

describe('movementLabel', () => {
  it('maps every movement type to a human label', () => {
    expect(movementLabel('OPENING_FLOAT')).toBe('Opening float')
    expect(movementLabel('CASH_SALE')).toBe('Cash sale')
    expect(movementLabel('CASH_REFUND')).toBe('Cash refund')
    expect(movementLabel('PAID_IN')).toBe('Paid in')
    expect(movementLabel('PAID_OUT')).toBe('Paid out')
    expect(movementLabel('DROP')).toBe('Drop')
  })
})

describe('isDebit', () => {
  it('is true only for a negative amount', () => {
    expect(isDebit(movement({ amount: '-5000' }))).toBe(true)
    expect(isDebit(movement({ amount: '5000' }))).toBe(false)
    expect(isDebit(movement({ amount: '0' }))).toBe(false)
  })
})

describe('varianceState', () => {
  it('is balanced for null, empty, or zero', () => {
    expect(varianceState(null)).toBe('balanced')
    expect(varianceState('')).toBe('balanced')
    expect(varianceState('0')).toBe('balanced')
    expect(varianceState('-0')).toBe('balanced')
  })

  it('is short for a negative variance and over for a positive one', () => {
    expect(varianceState('-500')).toBe('short')
    expect(varianceState('500')).toBe('over')
  })
})
