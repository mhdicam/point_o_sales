import { describe, it, expect } from 'vitest'
import {
  Money,
  money,
  add,
  sub,
  mulQty,
  sum,
  applyRate,
  extractInclusiveTax,
  allocate,
  allocateByWeights,
  roundToIncrement,
  formatMoney,
} from './money.js'

describe('money construction', () => {
  it('accepts integers, bigints, and integer strings', () => {
    expect(money(1500)).toBe(1500n)
    expect(money(1500n)).toBe(1500n)
    expect(money('1500')).toBe(1500n)
    expect(money('-1500')).toBe(-1500n)
  })

  it('rejects fractional numbers — no float may enter the money path', () => {
    expect(() => money(15.5)).toThrow(TypeError)
    expect(() => money(0.1)).toThrow(/integer number of minor units/)
  })

  it('rejects non-integer strings', () => {
    expect(() => money('15.50')).toThrow(TypeError)
    expect(() => money('abc')).toThrow(TypeError)
  })

  it('survives values beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = money('9007199254740993') // 2^53 + 1
    expect(add(huge, money(1))).toBe(9007199254740994n)
  })
})

describe('arithmetic', () => {
  it('adds, subtracts, and multiplies by quantity', () => {
    expect(add(money(1000), money(500))).toBe(1500n)
    expect(sub(money(1000), money(500))).toBe(500n)
    expect(mulQty(money(2500), 3)).toBe(7500n)
  })

  it('sums an empty list to zero', () => {
    expect(sum([])).toBe(0n)
    expect(sum([money(100), money(200), money(300)])).toBe(600n)
  })

  it('rejects fractional quantities', () => {
    expect(() => mulQty(money(1000), 1.5)).toThrow(/qty must be an integer/)
  })
})

describe('applyRate — percentage in basis points', () => {
  it('computes a 10% service charge', () => {
    expect(applyRate(money(100_000), 1000)).toBe(10_000n)
  })

  it('computes 11% PPN', () => {
    expect(applyRate(money(100_000), 1100)).toBe(11_000n)
  })

  it('rounds HALF_UP by default', () => {
    // 1005 * 10% = 100.5 → 101
    expect(applyRate(money(1005), 1000)).toBe(101n)
  })

  it('honours DOWN and UP explicitly', () => {
    expect(applyRate(money(1005), 1000, 'DOWN')).toBe(100n)
    expect(applyRate(money(1001), 1000, 'UP')).toBe(101n)
  })

  it('applies HALF_EVEN (banker rounding) at exact halves', () => {
    // 50 * 10% = 5 exactly, no rounding needed
    expect(applyRate(money(50), 1000, 'HALF_EVEN')).toBe(5n)
    // 25 * 10% = 2.5 → 2 (nearest even)
    expect(applyRate(money(25), 1000, 'HALF_EVEN')).toBe(2n)
    // 35 * 10% = 3.5 → 4 (nearest even)
    expect(applyRate(money(35), 1000, 'HALF_EVEN')).toBe(4n)
  })

  it('handles a negative base (discount) symmetrically', () => {
    expect(applyRate(money(-1000), 1000)).toBe(-100n)
  })
})

describe('extractInclusiveTax — design §6.3', () => {
  it('splits a tax-inclusive gross so net + tax === gross exactly', () => {
    const { net, tax } = extractInclusiveTax(money(111_000), 1100)
    expect(net).toBe(100_000n)
    expect(tax).toBe(11_000n)
    expect(add(net, tax)).toBe(111_000n)
  })

  it('never loses a minor unit on an awkward gross', () => {
    for (const gross of [1n, 7n, 99n, 1234n, 99_999n, 123_457n]) {
      const { net, tax } = extractInclusiveTax(money(gross), 1100)
      expect(add(net, tax)).toBe(gross)
    }
  })

  it('is a no-op at a zero rate', () => {
    const { net, tax } = extractInclusiveTax(money(50_000), 0)
    expect(net).toBe(50_000n)
    expect(tax).toBe(0n)
  })
})

describe('allocate — design §7.3 split-even invariant', () => {
  it('splits evenly when divisible', () => {
    expect(allocate(money(90_000), 3)).toEqual([30_000n, 30_000n, 30_000n])
  })

  it('distributes an indivisible remainder without losing units', () => {
    const parts = allocate(money(100_000), 3)
    expect(parts).toEqual([33_334n, 33_333n, 33_333n])
    expect(sum(parts)).toBe(100_000n)
  })

  it('holds the invariant SUM(parts) === total for many awkward combinations', () => {
    for (const total of [1n, 2n, 7n, 99n, 100n, 1001n, 99_999n, 123_457n]) {
      for (const n of [1, 2, 3, 4, 5, 7, 11, 13]) {
        const parts = allocate(money(total), n)
        expect(parts).toHaveLength(n)
        expect(sum(parts)).toBe(total)
      }
    }
  })

  it('splits a negative amount (refund) without losing units', () => {
    const parts = allocate(money(-100_000), 3)
    expect(sum(parts)).toBe(-100_000n)
    expect(parts).toEqual([-33_334n, -33_333n, -33_333n])
  })

  it('rejects a non-positive part count', () => {
    expect(() => allocate(money(1000), 0)).toThrow(RangeError)
    expect(() => allocate(money(1000), -1)).toThrow(RangeError)
  })
})

describe('allocateByWeights — proportional split preserving the total', () => {
  it('allocates proportionally', () => {
    const parts = allocateByWeights(money(100_000), [1n, 1n, 2n])
    expect(sum(parts)).toBe(100_000n)
    expect(parts).toEqual([25_000n, 25_000n, 50_000n])
  })

  it('preserves the total when weights divide unevenly', () => {
    const parts = allocateByWeights(money(10_000), [1n, 1n, 1n])
    expect(sum(parts)).toBe(10_000n)
  })

  it('falls back to an even split when all weights are zero', () => {
    const parts = allocateByWeights(money(9000), [0n, 0n, 0n])
    expect(sum(parts)).toBe(9000n)
    expect(parts).toEqual([3000n, 3000n, 3000n])
  })

  it('preserves the total across a spread of weights and amounts', () => {
    const weightSets: bigint[][] = [
      [1n, 2n, 3n],
      [7n, 11n, 13n, 17n],
      [1n, 0n, 5n],
      [100n, 1n],
    ]
    for (const weights of weightSets) {
      for (const total of [1n, 13n, 997n, 100_000n, 123_457n]) {
        const parts = allocateByWeights(money(total), weights)
        expect(sum(parts)).toBe(total)
      }
    }
  })

  it('rejects negative weights and empty input', () => {
    expect(() => allocateByWeights(money(100), [])).toThrow(RangeError)
    expect(() => allocateByWeights(money(100), [-1n, 2n])).toThrow(RangeError)
  })
})

describe('roundToIncrement — design §6 step 5', () => {
  it('rounds to the nearest 100 and reports the delta', () => {
    expect(roundToIncrement(money(12_345), 100)).toEqual({ rounded: 12_300n, delta: -45n })
    expect(roundToIncrement(money(12_355), 100)).toEqual({ rounded: 12_400n, delta: 45n })
  })

  it('is a no-op at increment 1', () => {
    expect(roundToIncrement(money(12_345), 1)).toEqual({ rounded: 12_345n, delta: 0n })
  })

  it('reports a zero delta when already on the increment', () => {
    expect(roundToIncrement(money(12_300), 100)).toEqual({ rounded: 12_300n, delta: 0n })
  })

  it('keeps rounded === original + delta so the ROUNDING charge row always reconciles', () => {
    for (const amount of [1n, 49n, 50n, 51n, 12_345n, 99_999n]) {
      for (const inc of [100, 500, 1000]) {
        const { rounded, delta } = roundToIncrement(money(amount), inc)
        expect(add(money(amount), delta)).toBe(rounded)
      }
    }
  })

  it('rejects a non-positive increment', () => {
    expect(() => roundToIncrement(money(100), 0)).toThrow(RangeError)
  })
})

describe('formatMoney', () => {
  it('formats IDR without decimals', () => {
    // Non-breaking spaces vary by ICU build, so assert on the digits.
    expect(formatMoney(money(1_500_000)).replace(/\s/g, ' ')).toContain('1.500.000')
  })
})

describe('Money namespace', () => {
  it('exposes the same helpers as the named exports', () => {
    expect(Money.of(100)).toBe(100n)
    expect(Money.add(Money.of(1), Money.of(2))).toBe(3n)
    expect(Money.ZERO).toBe(0n)
  })
})
