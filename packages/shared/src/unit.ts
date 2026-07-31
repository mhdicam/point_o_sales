/**
 * Unit conversion — S3-02, design §3.2.
 *
 * The risk in unit conversion: 1 tsp = 4.929 ml. Storing 4.929 as a float and
 * multiplying through a recipe drifts. Storing it scaled (4_929_000) as an
 * integer keeps the fractional part exact — multiplication distributes over
 * addition so a deep nested recipe never accumulates rounding error.
 *
 * Scale 1,000,000 gives six decimal places of precision: enough for cooking
 * (0.000001 g is sub-molecular), without approaching bigint range limits.
 */

export const UNIT_FACTOR_SCALE = 1_000_000n

/**
 * Convert a quantity from one unit to another within the same dimension.
 *
 * Both units must share a `baseUnitId` — conversion across dimensions (grams to
 * millilitres) needs a density, which is a per-ingredient fact and deliberately
 * out of scope (design §3.2).
 *
 * @param qty The quantity in `fromUnit`.
 * @param fromFactor The `factor` column of the source unit (scaled).
 * @param toFactor The `factor` column of the target unit (scaled).
 * @returns The quantity in `toUnit`, rounded to the nearest integer base unit.
 */
export function convertUnit(qty: bigint, fromFactor: bigint, toFactor: bigint): bigint {
  if (toFactor === 0n) throw new RangeError('Target unit factor cannot be zero.')
  // qty_from * fromFactor / toFactor, rounding half-up.
  const numerator = qty * fromFactor
  const quotient = numerator / toFactor
  const remainder = numerator % toFactor
  return remainder * 2n >= toFactor ? quotient + 1n : quotient
}
