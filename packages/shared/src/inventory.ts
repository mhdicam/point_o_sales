/**
 * Inventory quantity + valuation math — S6, design §4 (standards #2, #3).
 *
 * Two float-free ideas carry this file:
 *
 *   1. Stock quantity is stored in SCALED BASE UNITS — the variant's stock-unit
 *      base multiplied by UNIT_FACTOR_SCALE (the same scale Unit.factor uses,
 *      §3.2). A recipe that consumes 0.5 g or 30 ml therefore stays an exact
 *      integer through a deep recipe chain; nothing ever holds a float.
 *
 *   2. Valuation is DERIVED, never stored (standard #3). On-hand is SUM(qty) and
 *      the moving-average cost is a fold over the ledger in creation order — an
 *      inbound row restates the average, an outbound row consumes at it. There is
 *      no averageCost column to drift.
 *
 * `costPerUnit` throughout is minor units per ONE base unit (standard #2).
 */

import { UNIT_FACTOR_SCALE } from './unit.js'

/**
 * Convert a human quantity in some unit to scaled base units.
 *
 * `unitFactor` is the unit's `factor` column: base units per one of this unit,
 * already scaled (1 kg → 1_000_000_000 when the base is the gram). `qtyScaled`
 * is the quantity itself scaled by UNIT_FACTOR_SCALE, so a fractional input
 * (0.5) is passed as 500_000 and never as a float.
 *
 *   scaledBase = qtyScaled * unitFactor / SCALE
 *
 * The single division rounds half-up; at six decimals of a base unit the
 * residue is sub-physical (0.000001 g), so rounding there cannot matter.
 */
export function toBaseScaled(qtyScaled: bigint, unitFactor: bigint): bigint {
  const numerator = qtyScaled * unitFactor
  const quotient = numerator / UNIT_FACTOR_SCALE
  const remainder = numerator % UNIT_FACTOR_SCALE
  // Round half away from zero so negative consumption rounds symmetrically.
  const half = UNIT_FACTOR_SCALE
  if (remainder === 0n) return quotient
  const twice = (remainder < 0n ? -remainder : remainder) * 2n
  if (twice < half) return quotient
  return numerator < 0n ? quotient - 1n : quotient + 1n
}

/**
 * Present scaled base units back in a display unit, as a scaled quantity.
 * Inverse of {@link toBaseScaled}: `qtyScaled = scaledBase * SCALE / unitFactor`.
 * The caller renders it (dividing by SCALE for the decimal) — it never computes
 * money or further stock from it.
 */
export function fromBaseScaled(scaledBase: bigint, unitFactor: bigint): bigint {
  if (unitFactor === 0n) throw new RangeError('Unit factor cannot be zero.')
  const numerator = scaledBase * UNIT_FACTOR_SCALE
  const quotient = numerator / unitFactor
  const remainder = numerator % unitFactor
  if (remainder === 0n) return quotient
  const twice = (remainder < 0n ? -remainder : remainder) * 2n
  if (twice < unitFactor) return quotient
  return numerator < 0n ? quotient - 1n : quotient + 1n
}

/** One ledger row, reduced to just what valuation needs, in ledger order. */
export interface StockLot {
  /** Signed scaled base units: positive = in, negative = out. */
  qty: bigint
  /** Minor units per one base unit, or null (a pure quantity correction). */
  costPerUnit: bigint | null
}

export interface StockValuation {
  /** On-hand, scaled base units = SUM(qty). Can be negative if oversold. */
  onHand: bigint
  /** Moving-average cost, minor units per one base unit. Zero when empty. */
  avgCost: bigint
  /** Inventory value, minor units = onHand * avgCost / SCALE (rounded). */
  value: bigint
}

/**
 * Fold the ledger into on-hand + moving-average cost + value (§4.3).
 *
 * Moving-average semantics: an inbound row (qty > 0) with a cost blends into the
 * running average weighted by quantity; an outbound row (qty < 0) leaves the
 * average untouched and simply reduces on-hand (it consumes AT the average). An
 * inbound row with no cost (a positive stock-take) is treated as arriving at the
 * current average, so it does not dilute value toward zero.
 *
 * Rows MUST be in creation order — the average at row N depends on rows < N.
 */
export function valuate(lots: readonly StockLot[]): StockValuation {
  let onHand = 0n
  // Total value of on-hand stock, minor units. avgCost is derived from it.
  let value = 0n

  for (const lot of lots) {
    if (lot.qty > 0n) {
      const cost = lot.costPerUnit ?? avgCostOf(onHand, value)
      onHand += lot.qty
      value += mulDivScale(lot.qty, cost)
    } else if (lot.qty < 0n) {
      const avg = avgCostOf(onHand, value)
      onHand += lot.qty // qty is negative
      value += mulDivScale(lot.qty, avg) // reduces value at the average
    }
    // qty === 0n: a no-op row, ignored.
  }

  const avgCost = avgCostOf(onHand, value)
  return { onHand, avgCost, value: onHand === 0n ? 0n : value }
}

/**
 * The moving-average cost to charge an outbound movement of `onHand`/`value`
 * state — exported so the sale path can snapshot the same figure it would
 * derive, keeping COGS and the ledger in agreement.
 */
export function avgCostOf(onHand: bigint, value: bigint): bigint {
  if (onHand <= 0n) return 0n
  // value is over scaled base units; avg is per base unit → multiply by SCALE.
  const numerator = value * UNIT_FACTOR_SCALE
  const quotient = numerator / onHand
  const remainder = numerator % onHand
  if (remainder === 0n) return quotient
  return remainder * 2n >= onHand ? quotient + 1n : quotient
}

/** qty(scaled base) * costPerBaseUnit / SCALE → minor units, rounded half-up. */
function mulDivScale(qtyScaledBase: bigint, costPerUnit: bigint): bigint {
  const numerator = qtyScaledBase * costPerUnit
  const quotient = numerator / UNIT_FACTOR_SCALE
  const remainder = numerator % UNIT_FACTOR_SCALE
  if (remainder === 0n) return quotient
  const twice = (remainder < 0n ? -remainder : remainder) * 2n
  if (twice < UNIT_FACTOR_SCALE) return quotient
  return numerator < 0n ? quotient - 1n : quotient + 1n
}
