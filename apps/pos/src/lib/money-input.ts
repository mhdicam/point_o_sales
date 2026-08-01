/**
 * Money display adapters — the FE edits prices as human decimal strings
 * ("12.50") but the wire carries integer minor units as strings ("1250").
 * These convert at the form edge only, never for arithmetic (standard #2:
 * rounding happens once, in the backend bill pipeline — the FE never does money
 * math).
 *
 * `minorUnitDigits` defaults to 2. IDR (0 digits) callers pass 0.
 */

/** Minor-unit string ("1250") → editable major string ("12.50"). */
export function minorToInput(minor: string, minorUnitDigits = 2): string {
  if (minorUnitDigits === 0) return minor
  const negative = minor.startsWith('-')
  const digits = (negative ? minor.slice(1) : minor).replace(/\D/g, '') || '0'
  const padded = digits.padStart(minorUnitDigits + 1, '0')
  const whole = padded.slice(0, padded.length - minorUnitDigits)
  const frac = padded.slice(padded.length - minorUnitDigits)
  return `${negative ? '-' : ''}${whole}.${frac}`
}

/**
 * Editable major string ("12.50") → minor-unit string ("1250"), or null when
 * the input is not a valid money amount. Rejects more fractional digits than the
 * currency allows rather than silently truncating.
 */
export function inputToMinor(input: string, minorUnitDigits = 2): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed)
  if (!match) return null

  const sign = match[1] ?? ''
  const whole = match[2] ?? '0'
  const frac = match[3] ?? ''
  if (frac.length > minorUnitDigits) return null

  const paddedFrac = frac.padEnd(minorUnitDigits, '0')
  const combined = `${whole}${paddedFrac}`.replace(/^0+(?=\d)/, '')
  const normalized = combined === '' ? '0' : combined
  // Preserve a leading minus only for a non-zero magnitude.
  return sign === '-' && normalized !== '0' ? `-${normalized}` : normalized
}
