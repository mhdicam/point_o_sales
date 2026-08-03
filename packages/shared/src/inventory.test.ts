import { describe, it, expect } from 'vitest'
import {
  toBaseScaled,
  fromBaseScaled,
  valuate,
  avgCostOf,
  extendedCost,
  type StockLot,
} from './inventory.js'
import { UNIT_FACTOR_SCALE } from './unit.js'

const SCALE = UNIT_FACTOR_SCALE

describe('toBaseScaled', () => {
  it('is identity when the unit IS the base (factor = scale)', () => {
    // 5 grams, base is gram → scaled base is 5 * SCALE.
    expect(toBaseScaled(5n * SCALE, SCALE)).toBe(5n * SCALE)
  })

  it('scales up a derived unit (1 kg = 1000 g)', () => {
    // 1 kg, factor = 1000 * SCALE → 1000 g worth of scaled base.
    expect(toBaseScaled(1n * SCALE, 1000n * SCALE)).toBe(1000n * SCALE)
  })

  it('keeps a fractional quantity exact (0.5 g)', () => {
    // 0.5 passed as SCALE/2; base is gram → 0.5 g scaled.
    expect(toBaseScaled(SCALE / 2n, SCALE)).toBe(SCALE / 2n)
  })

  it('handles a fractional unit factor without drifting (1 tsp = 4.929 ml)', () => {
    // 2 tsp, factor 4_929_000 (4.929 * SCALE), base ml → 9.858 ml scaled.
    const tspFactor = 4_929_000n
    expect(toBaseScaled(2n * SCALE, tspFactor)).toBe(9_858_000n)
  })

  it('rounds a negative consumption symmetrically', () => {
    expect(toBaseScaled(-(SCALE / 2n), SCALE)).toBe(-(SCALE / 2n))
  })
})

describe('fromBaseScaled', () => {
  it('inverts toBaseScaled for a whole conversion', () => {
    const base = toBaseScaled(1n * SCALE, 1000n * SCALE) // 1 kg → grams
    expect(fromBaseScaled(base, 1000n * SCALE)).toBe(1n * SCALE) // back to 1 kg
  })

  it('throws on a zero factor', () => {
    expect(() => fromBaseScaled(1n, 0n)).toThrow(RangeError)
  })
})

describe('valuate — moving average (§4.3)', () => {
  const base = (n: bigint) => n * SCALE

  it('is empty for no lots', () => {
    expect(valuate([])).toEqual({ onHand: 0n, avgCost: 0n, value: 0n })
  })

  it('sums on-hand across inbound and outbound (standard #3)', () => {
    const lots: StockLot[] = [
      { qty: base(10n), costPerUnit: 500n },
      { qty: -base(3n), costPerUnit: null },
      { qty: base(5n), costPerUnit: 500n },
    ]
    expect(valuate(lots).onHand).toBe(base(12n))
  })

  it('blends the average on a second, pricier purchase', () => {
    // 10 @ 500 then 10 @ 700 → avg 600 per base unit.
    const lots: StockLot[] = [
      { qty: base(10n), costPerUnit: 500n },
      { qty: base(10n), costPerUnit: 700n },
    ]
    const v = valuate(lots)
    expect(v.onHand).toBe(base(20n))
    expect(v.avgCost).toBe(600n)
    expect(v.value).toBe(base(20n) / SCALE * 600n) // 20 * 600 = 12000
  })

  it('consumes at the average and leaves the average unchanged', () => {
    // 10 @ 500, 10 @ 700 (avg 600), then consume 5 → value drops by 5*600.
    const lots: StockLot[] = [
      { qty: base(10n), costPerUnit: 500n },
      { qty: base(10n), costPerUnit: 700n },
      { qty: -base(5n), costPerUnit: null },
    ]
    const v = valuate(lots)
    expect(v.onHand).toBe(base(15n))
    expect(v.avgCost).toBe(600n) // unchanged by consumption
    expect(v.value).toBe(15n * 600n) // 9000
  })

  it('treats a costless positive stock-take as arriving at the current average', () => {
    // 10 @ 500 (avg 500), then +5 with no cost → avg stays 500, not diluted.
    const lots: StockLot[] = [
      { qty: base(10n), costPerUnit: 500n },
      { qty: base(5n), costPerUnit: null },
    ]
    const v = valuate(lots)
    expect(v.onHand).toBe(base(15n))
    expect(v.avgCost).toBe(500n)
    expect(v.value).toBe(15n * 500n)
  })

  it('zeroes value when fully consumed', () => {
    const lots: StockLot[] = [
      { qty: base(4n), costPerUnit: 250n },
      { qty: -base(4n), costPerUnit: null },
    ]
    const v = valuate(lots)
    expect(v.onHand).toBe(0n)
    expect(v.value).toBe(0n)
  })
})

describe('avgCostOf', () => {
  it('is zero for empty or negative on-hand', () => {
    expect(avgCostOf(0n, 0n)).toBe(0n)
    expect(avgCostOf(-1n, 100n)).toBe(0n)
  })

  it('derives per-base-unit cost from value and on-hand', () => {
    // value 12000 minor over 20 base units → 600 per base unit.
    expect(avgCostOf(20n * SCALE, 12000n)).toBe(600n)
  })
})

describe('extendedCost — per-movement COGS (§4.3)', () => {
  const base = (n: bigint) => n * SCALE

  it('multiplies whole base units by cost per unit', () => {
    // 5 base units @ 600 minor per unit → 3000 minor.
    expect(extendedCost(base(5n), 600n)).toBe(3000n)
  })

  it('negates for an outbound consumption row', () => {
    // A SALE_CONSUMPTION of -5 base units @ 600 → -3000; negated = 3000 COGS.
    expect(extendedCost(-base(5n), 600n)).toBe(-3000n)
    expect(-extendedCost(-base(5n), 600n)).toBe(3000n)
  })

  it('handles a fractional consumption (0.5 base unit)', () => {
    // 0.5 base unit @ 600 → 300 minor.
    expect(extendedCost(SCALE / 2n, 600n)).toBe(300n)
  })

  it('rounds half away from zero', () => {
    // 1 base-unit scaled residue that lands exactly on the half.
    // qty = 1 (raw scaled residue), cost = SCALE/2 → numerator = SCALE/2,
    // half of SCALE → rounds up to 1.
    expect(extendedCost(1n, SCALE / 2n)).toBe(1n)
    expect(extendedCost(-1n, SCALE / 2n)).toBe(-1n)
  })

  it('agrees with the fold valuate uses for consumption value', () => {
    // 10 @ 500, 10 @ 700 (avg 600), consume 5 → value falls by extendedCost.
    const before = valuate([
      { qty: base(10n), costPerUnit: 500n },
      { qty: base(10n), costPerUnit: 700n },
    ])
    const after = valuate([
      { qty: base(10n), costPerUnit: 500n },
      { qty: base(10n), costPerUnit: 700n },
      { qty: -base(5n), costPerUnit: null },
    ])
    expect(after.value - before.value).toBe(extendedCost(-base(5n), 600n))
  })
})
