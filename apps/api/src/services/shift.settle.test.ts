/**
 * Unit tests for the pure shift reconciliation math (design §14.3). No DB, no
 * fixtures — just the drawer arithmetic and the tolerance rule.
 */

import { describe, it, expect } from 'vitest'
import { expectedCash, cashVariance, absBigInt, varianceNeedsReason } from './shift.settle.js'

describe('expectedCash — derived drawer balance (§14.3, standard #3)', () => {
  it('is the movement sum (which already includes the opening float)', () => {
    // opening 200_000 + cash sales 150_000 − paid-out 50_000 = 300_000
    expect(expectedCash(200_000n + 150_000n - 50_000n)).toBe(300_000n)
  })

  it('is the float alone when no other movement happened', () => {
    expect(expectedCash(200_000n)).toBe(200_000n)
  })
})

describe('cashVariance — counted minus expected (§14.3)', () => {
  it('is zero when the drawer matches', () => {
    expect(cashVariance(300_000n, 300_000n)).toBe(0n)
  })

  it('is negative when the drawer is short', () => {
    expect(cashVariance(295_000n, 300_000n)).toBe(-5_000n)
  })

  it('is positive when the drawer is over', () => {
    expect(cashVariance(305_000n, 300_000n)).toBe(5_000n)
  })
})

describe('absBigInt', () => {
  it('returns the magnitude of a negative value', () => {
    expect(absBigInt(-5_000n)).toBe(5_000n)
  })

  it('leaves a non-negative value unchanged', () => {
    expect(absBigInt(5_000n)).toBe(5_000n)
    expect(absBigInt(0n)).toBe(0n)
  })
})

describe('varianceNeedsReason — tolerance rule (§14.3)', () => {
  it('with zero tolerance, any non-zero variance needs a reason', () => {
    expect(varianceNeedsReason(0n, 0n)).toBe(false)
    expect(varianceNeedsReason(-1n, 0n)).toBe(true)
    expect(varianceNeedsReason(1n, 0n)).toBe(true)
  })

  it('within tolerance needs no reason; beyond it does (either sign)', () => {
    const tolerance = 5_000n
    expect(varianceNeedsReason(5_000n, tolerance)).toBe(false)
    expect(varianceNeedsReason(-5_000n, tolerance)).toBe(false)
    expect(varianceNeedsReason(5_001n, tolerance)).toBe(true)
    expect(varianceNeedsReason(-5_001n, tolerance)).toBe(true)
  })
})
