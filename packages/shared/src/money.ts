/**
 * Money — integer minor units, no floats anywhere (standard #2).
 *
 * Design doc §1 principle 3: every monetary amount is a whole number of minor
 * units. For IDR the minor unit is the rupiah itself (Indonesia has no
 * circulating sen), but the type does not care — it is unit-agnostic and the
 * scale is a presentation concern.
 *
 * `bigint` rather than `number` on purpose: a tenant with a year of transactions
 * can exceed 2^53 in aggregate reporting, and bigint arithmetic has no silent
 * precision cliff. Prisma maps this to a Postgres BIGINT.
 *
 * Rounding is never implicit. Percentage helpers require an explicit RoundingMode
 * so the single rounding point in the bill pipeline (design §6 step 5) is a
 * deliberate call rather than an accident of floating point.
 */

declare const moneyBrand: unique symbol

/** A monetary amount in integer minor units. */
export type Money = bigint & { readonly [moneyBrand]?: never }

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP'

/** Basis points: 1 bp = 0.01%. A 10% rate is 1000 bp. */
export type BasisPoints = number

export const ZERO: Money = 0n as Money

export function money(value: bigint | number | string): Money {
  if (typeof value === 'bigint') return value as Money
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TypeError(
        `Money must be an integer number of minor units, received ${value}. ` +
          'Convert at the boundary — never let a fractional value into the money path.'
      )
    }
    return BigInt(value) as Money
  }
  const trimmed = value.trim()
  if (!/^-?\d+$/.test(trimmed)) {
    throw new TypeError(`Money string must be an integer, received "${value}".`)
  }
  return BigInt(trimmed) as Money
}

export const add = (a: Money, b: Money): Money => (a + b) as Money
export const sub = (a: Money, b: Money): Money => (a - b) as Money
export const neg = (a: Money): Money => -a as Money
export const abs = (a: Money): Money => (a < 0n ? -a : a) as Money

/** Multiply by a whole quantity (line total = unit price x qty). */
export function mulQty(amount: Money, qty: number | bigint): Money {
  const q = typeof qty === 'bigint' ? qty : BigInt(assertInteger(qty, 'qty'))
  return (amount * q) as Money
}

export const sum = (amounts: readonly Money[]): Money =>
  amounts.reduce<Money>((acc, a) => (acc + a) as Money, ZERO)

export const isZero = (a: Money): boolean => a === 0n
export const isNegative = (a: Money): boolean => a < 0n
export const compare = (a: Money, b: Money): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0)
export const min = (a: Money, b: Money): Money => (a < b ? a : b)
export const max = (a: Money, b: Money): Money => (a > b ? a : b)

/**
 * Apply a basis-point rate, rounding explicitly.
 *
 * Used for percentage discounts, service charge, and exclusive tax. The caller
 * names the rounding mode because this is the one place a fraction appears.
 */
export function applyRate(
  base: Money,
  rateBp: BasisPoints,
  mode: RoundingMode = 'HALF_UP'
): Money {
  assertInteger(rateBp, 'rateBp')
  return divideRounded(base * BigInt(rateBp), 10_000n, mode)
}

/**
 * Extract the tax portion from a gross (tax-inclusive) amount — design §6.3.
 *
 * net = gross / (1 + rate); tax = gross - net. Computing the net first and
 * subtracting guarantees net + tax === gross exactly, with no lost minor unit.
 */
export function extractInclusiveTax(
  gross: Money,
  rateBp: BasisPoints,
  mode: RoundingMode = 'HALF_UP'
): { net: Money; tax: Money } {
  assertInteger(rateBp, 'rateBp')
  const denominator = 10_000n + BigInt(rateBp)
  const net = divideRounded(gross * 10_000n, denominator, mode)
  return { net, tax: sub(gross, net) }
}

/**
 * Split an amount into `parts` shares that sum back to exactly the original.
 *
 * Design §7.3 requires SUM(bill.total) === order total for an even split. The
 * indivisible remainder is distributed one minor unit at a time to the leading
 * shares rather than being dropped, so nothing evaporates in rounding.
 */
export function allocate(amount: Money, parts: number): Money[] {
  const n = assertInteger(parts, 'parts')
  if (n <= 0) throw new RangeError(`Cannot split into ${n} parts.`)

  const sign = amount < 0n ? -1n : 1n
  const magnitude = amount < 0n ? -amount : amount
  const big = BigInt(n)
  const base = magnitude / big
  const remainder = Number(magnitude % big)

  return Array.from({ length: n }, (_, i) =>
    (sign * (base + (i < remainder ? 1n : 0n))) as Money
  )
}

/**
 * Allocate proportionally to weights, preserving the total exactly.
 *
 * Needed when an order-level discount is pushed down onto lines (largest
 * remainder method, so the parts still sum to the whole).
 */
export function allocateByWeights(amount: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) throw new RangeError('allocateByWeights requires at least one weight.')
  if (weights.some((w) => w < 0n)) throw new RangeError('Weights must be non-negative.')

  const totalWeight = weights.reduce((a, b) => a + b, 0n)
  if (totalWeight === 0n) return allocate(amount, weights.length)

  const sign = amount < 0n ? -1n : 1n
  const magnitude = amount < 0n ? -amount : amount

  const floors = weights.map((w) => (magnitude * w) / totalWeight)
  const distributed = floors.reduce((a, b) => a + b, 0n)
  let leftover = Number(magnitude - distributed)

  // Hand the leftover units to the largest fractional parts first.
  const order = weights
    .map((w, i) => ({ i, frac: (magnitude * w) % totalWeight }))
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i))

  const result = [...floors]
  for (const { i } of order) {
    if (leftover <= 0) break
    result[i] = (result[i] ?? 0n) + 1n
    leftover -= 1
  }

  return result.map((v) => (sign * v) as Money)
}

/** Integer division with an explicit rounding mode. No float involved. */
function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): Money {
  if (denominator === 0n) throw new RangeError('Division by zero in money arithmetic.')

  const negative = numerator < 0n !== denominator < 0n
  const absNum = numerator < 0n ? -numerator : numerator
  const absDen = denominator < 0n ? -denominator : denominator

  const quotient = absNum / absDen
  const remainder = absNum % absDen

  let rounded: bigint
  if (remainder === 0n) {
    rounded = quotient
  } else {
    switch (mode) {
      case 'DOWN':
        rounded = quotient
        break
      case 'UP':
        rounded = quotient + 1n
        break
      case 'HALF_UP':
        rounded = remainder * 2n >= absDen ? quotient + 1n : quotient
        break
      case 'HALF_EVEN': {
        const twice = remainder * 2n
        if (twice > absDen) rounded = quotient + 1n
        else if (twice < absDen) rounded = quotient
        else rounded = quotient % 2n === 0n ? quotient : quotient + 1n
        break
      }
    }
  }

  return ((negative ? -rounded : rounded)) as Money
}

/**
 * Round to a cash-payable increment — design §6 step 5.
 *
 * Indonesian cash rounding commonly drops to the nearest 100 or 500 because
 * small coins are scarce. Returns the delta so it can be persisted as an
 * `OrderCharge kind=ROUNDING` row instead of silently mutating the total.
 */
export function roundToIncrement(
  amount: Money,
  increment: number,
  mode: RoundingMode = 'HALF_UP'
): { rounded: Money; delta: Money } {
  const inc = BigInt(assertInteger(increment, 'increment'))
  if (inc <= 0n) throw new RangeError('Rounding increment must be positive.')
  if (inc === 1n) return { rounded: amount, delta: ZERO }

  const units = divideRounded(amount, inc, mode)
  const rounded = (units * inc) as Money
  return { rounded, delta: sub(rounded, amount) }
}

/** Format for display only. Never feed the result back into arithmetic. */
export function formatMoney(
  amount: Money,
  opts: { locale?: string; currency?: string; minorUnitDigits?: number } = {}
): string {
  const { locale = 'id-ID', currency = 'IDR', minorUnitDigits = 0 } = opts
  const divisor = 10 ** minorUnitDigits
  const asNumber = Number(amount) / divisor
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: minorUnitDigits,
    maximumFractionDigits: minorUnitDigits,
  }).format(asNumber)
}

function assertInteger(value: number, label: string): number {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer, received ${value}.`)
  }
  return value
}

export const Money = {
  ZERO,
  of: money,
  add,
  sub,
  neg,
  abs,
  mulQty,
  sum,
  isZero,
  isNegative,
  compare,
  min,
  max,
  applyRate,
  extractInclusiveTax,
  allocate,
  allocateByWeights,
  roundToIncrement,
  format: formatMoney,
} as const
