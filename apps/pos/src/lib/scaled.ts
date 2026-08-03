/**
 * Scaled-decimal helpers for the inventory + PO forms (S6-09).
 *
 * Quantities cross the wire as integers scaled by UNIT_FACTOR_SCALE (1e6) and
 * money as minor units — both BigInt, never a float (standard #2). A user types
 * a plain decimal ("2.5" kg, "12000" rupiah); these turn that into the exact
 * scaled bigint for the request, and back into a readable decimal for display,
 * with no floating-point rounding in between.
 */

import { UNIT_FACTOR_SCALE } from '@brewsync/shared'

/**
 * Parses a user-typed decimal (e.g. "2.5") into a quantity scaled by
 * UNIT_FACTOR_SCALE, as BigInt. Throws on a malformed or negative input so the
 * form can surface a field error rather than send garbage. More than 6 fraction
 * digits is rejected — the scale cannot represent it exactly.
 */
export function parseScaledQty(input: string): bigint {
  const trimmed = input.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('Enter a positive number (up to 6 decimal places).')
  }
  const [whole = '0', frac = ''] = trimmed.split('.')
  if (frac.length > 6) throw new Error('At most 6 decimal places are supported.')
  const padded = frac.padEnd(6, '0')
  return BigInt(whole) * UNIT_FACTOR_SCALE + BigInt(padded)
}

/** Formats a UNIT_FACTOR_SCALE-scaled quantity string as a trimmed decimal. */
export function formatScaledQty(scaled: string | bigint): string {
  const value = typeof scaled === 'bigint' ? scaled : BigInt(scaled)
  const neg = value < 0n
  const abs = neg ? -value : value
  const whole = abs / UNIT_FACTOR_SCALE
  const frac = (abs % UNIT_FACTOR_SCALE).toString().padStart(6, '0').replace(/0+$/, '')
  const text = frac ? `${whole}.${frac}` : `${whole}`
  return neg ? `-${text}` : text
}

/**
 * Parses a user-typed whole-number amount of minor units (e.g. "12000") into
 * BigInt. Rupiah has no sub-unit here, so fractions are rejected.
 */
export function parseMinorUnits(input: string): bigint {
  const trimmed = input.trim()
  if (!/^\d+$/.test(trimmed)) throw new Error('Enter a whole amount (minor units).')
  return BigInt(trimmed)
}

/**
 * Parses a user-typed tax percentage (e.g. "11" or "11.5") into integer basis
 * points (1% = 100 bp). Done by exact string arithmetic — no float rounding near
 * money (standard #2) — so more than 2 fraction digits, which basis points
 * cannot represent, is rejected rather than silently rounded.
 */
export function parseTaxRateBp(input: string): number {
  const trimmed = input.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('Enter a non-negative percentage (up to 2 decimal places).')
  }
  const [whole = '0', frac = ''] = trimmed.split('.')
  if (frac.length > 2) throw new Error('At most 2 decimal places are supported.')
  const padded = frac.padEnd(2, '0')
  return Number(whole) * 100 + Number(padded)
}
