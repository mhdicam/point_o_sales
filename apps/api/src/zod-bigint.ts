/**
 * Zod helpers for BigInt fields crossing the HTTP boundary.
 *
 * Money is stored in integer minor units and unit factors are scaled integers
 * (standard #2) — both are BigInt in the database. JSON has no BigInt, so they
 * travel as decimal strings. A JSON number is accepted for convenience but only
 * while it is a safe integer: past 2^53 the parse is already lossy before we see
 * it, and silently accepting that would corrupt a total.
 *
 * A float is always rejected rather than truncated. `basePrice: 15000.5` is a
 * caller sending major units or a rounding bug, not a value to guess at.
 */

import { z } from 'zod'

/**
 * @param opts.signed Allow negative values — required for `Modifier.priceDelta`,
 *   where a negative delta is a legitimate discount-style option.
 */
type Sign = 'signed' | 'non-negative' | 'positive'

const PATTERNS: Record<Sign, RegExp> = {
  signed: /^-?(0|[1-9][0-9]*)$/,
  'non-negative': /^(0|[1-9][0-9]*)$/,
  positive: /^[1-9][0-9]*$/,
}

const LABELS: Record<Sign, string> = {
  signed: 'an integer',
  'non-negative': 'a non-negative integer',
  positive: 'a positive integer',
}

/**
 * @param sign `signed` allows negatives — required for `Modifier.priceDelta`,
 *   where a negative delta is a legitimate discount-style option. `positive`
 *   excludes zero, for values used as a divisor (`Unit.factor`).
 */
function bigIntSchema(sign: Sign) {
  const label = LABELS[sign]

  return z
    .union([z.string().regex(PATTERNS[sign], `must be ${label}`), z.number()])
    .transform((raw, ctx) => {
      if (typeof raw === 'number') {
        if (!Number.isSafeInteger(raw)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `must be ${label}; send a string for values beyond 2^53`,
          })
          return z.NEVER
        }
        if ((sign === 'non-negative' && raw < 0) || (sign === 'positive' && raw <= 0)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be ${label}` })
          return z.NEVER
        }
        return BigInt(raw)
      }
      return BigInt(raw)
    })
}

/** Non-negative money in minor units — prices, totals. */
export const minorUnits = bigIntSchema('non-negative')

/** Signed money in minor units — price deltas, adjustments. */
export const signedMinorUnits = bigIntSchema('signed')

/** Strictly positive scaled integer — `Unit.factor`, which is a divisor. */
export const positiveScaled = bigIntSchema('positive')
