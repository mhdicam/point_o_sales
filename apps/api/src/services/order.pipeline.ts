/**
 * Bill pipeline — S4-04/05/06, design §6.
 *
 * The one place order money is turned into a total. Pure and DB-free on purpose:
 * every subtle money bug in a POS lives in the *order* of discount, service
 * charge, tax, and rounding, so that order is fixed here (§6.1) and exercised by
 * a table-driven unit test with no fixtures.
 *
 * Fixed order — NOT negotiable per transaction (§6.1):
 *
 *   1. subtotal        = Σ line subtotals (priceSnapshot + modifierDelta, × qty)
 *   2. − discounts       item-level first, then order-level (§6.4)
 *   3. + service charge  percent of the discounted subtotal
 *   4. ± tax             exclusive adds; inclusive extracts (§6.3)
 *   5. rounding          exactly once, here
 *   6. = total
 *   7. + gratuity        outside the total, never taxed
 *
 * Standard #2: every amount is a `bigint` minor unit; the single rounding point
 * is `roundToIncrement` at step 5. Composes only the `@brewsync/shared` money
 * helpers — it writes no new money math of its own.
 *
 * Each non-item component becomes one `OrderCharge` draft row (§6.2) carrying its
 * `basis`, `rate`, signed `amount`, and `taxable` flag, in pipeline order.
 * Receipts and tax reports aggregate these rows rather than recomputing.
 *
 * Inclusive vs exclusive tax is configuration, not a code branch a caller makes
 * (§6.3) — the mode lives on the Outlet and the pipeline reads it:
 *
 *   - Exclusive: displayed prices are net; tax is ADDED at step 4 and the TAX row
 *     contributes to the total.
 *   - Inclusive: displayed prices are gross; the tax already sits inside the line
 *     subtotals. `extractInclusiveTax` splits it out so it can be reported, but
 *     the TAX row is a MEMO — it does not add to the total (that would double-count
 *     the tax already in the gross). `taxContributesToTotal` in the result marks
 *     which mode produced the rows, so a receipt/report can reconstruct the total
 *     the same way the pipeline did: it holds the outlet's `taxInclusive` flag.
 *
 * `total` is the authoritative return value — reconstruction from rows must branch
 * on the same flag, never sum blindly across both modes.
 */

import {
  ZERO,
  add,
  sum,
  neg,
  applyRate,
  extractInclusiveTax,
  roundToIncrement,
  type Money,
} from '@brewsync/shared'

/** Mirrors the Prisma `OrderChargeKind` enum; kept local so the pipeline stays DB-free. */
export type OrderChargeKind = 'DISCOUNT' | 'SERVICE_CHARGE' | 'TAX' | 'ROUNDING' | 'GRATUITY'

/** Outlet fiscal configuration (design §6.3 / §4.2). Basis points, no float. */
export interface FiscalConfig {
  taxInclusive: boolean
  taxRateBp: number
  serviceChargeRateBp: number
  roundingIncrement: number
  /**
   * Whether the service charge joins the tax base (PB1 on service is the common
   * Indonesian case). Configuration, not a per-transaction choice; defaults true.
   */
  serviceChargeTaxable?: boolean
}

/** A discount, item- or order-scoped, by percent OR fixed nominal (§6.4). */
export interface DiscountInput {
  label: string
  /** Percent as basis points (1000 = 10%). Mutually exclusive with `amountMinor`. */
  rateBp?: number
  /** Fixed nominal magnitude in minor units (positive). */
  amountMinor?: bigint
}

/** One item-scoped discount, targeting a line by index into `lines`. */
export interface ItemDiscountInput extends DiscountInput {
  lineIndex: number
}

export interface PipelineLine {
  /** (priceSnapshot + modifierDelta) × qty, in minor units. Never negative. */
  subtotalMinor: bigint
}

export interface PipelineInput {
  lines: PipelineLine[]
  fiscal: FiscalConfig
  /** Applied first, each against its target line's subtotal (§6.4). */
  itemDiscounts?: ItemDiscountInput[]
  /** Applied after item discounts, each against the running discounted subtotal. */
  orderDiscounts?: DiscountInput[]
  /** Optional tip; sits outside the total and is never taxed (§6.1 step 7). */
  gratuityMinor?: bigint
}

/** A draft `OrderCharge` row — persisted verbatim by OrderService. */
export interface ChargeDraft {
  kind: OrderChargeKind
  label: string
  basis: Money
  rateBp: number | null
  /** Signed minor units: discounts negative, charges positive (§6.2). */
  amount: Money
  taxable: boolean
  sortOrder: number
}

export interface PipelineResult {
  subtotal: Money
  charges: ChargeDraft[]
  /** The §6 total after the single rounding step. Excludes gratuity. */
  total: Money
  /** Total + gratuity — what the customer actually pays. */
  amountDue: Money
  /**
   * False in inclusive mode, where the TAX row is a memo already inside the line
   * subtotals. A consumer reconstructing `total` from rows must respect this.
   */
  taxContributesToTotal: boolean
}

const asMoney = (v: bigint): Money => v as Money

/** Resolves a discount to a positive magnitude against `base`. */
function discountMagnitude(input: DiscountInput, base: Money): Money {
  if (input.rateBp !== undefined && input.amountMinor !== undefined) {
    throw new Error(`Discount "${input.label}" sets both a percent and a fixed amount.`)
  }
  if (input.rateBp !== undefined) {
    return applyRate(base, input.rateBp)
  }
  if (input.amountMinor !== undefined) {
    // A fixed discount never drives a line/base below zero (§6.4 — discounts
    // reduce the subtotal, they do not create a negative one).
    const magnitude = asMoney(input.amountMinor < 0n ? -input.amountMinor : input.amountMinor)
    return magnitude > base ? base : magnitude
  }
  throw new Error(`Discount "${input.label}" sets neither a percent nor a fixed amount.`)
}

/**
 * Runs the §6 pipeline. Deterministic, one direction, one rounding.
 */
export function runBillPipeline(input: PipelineInput): PipelineResult {
  const { fiscal } = input
  const serviceChargeTaxable = fiscal.serviceChargeTaxable ?? true

  const charges: ChargeDraft[] = []
  let sortOrder = 0
  const nextSort = (): number => sortOrder++

  // Step 1 — subtotal.
  const lineSubtotals = input.lines.map((l) => asMoney(l.subtotalMinor))
  const subtotal = sum(lineSubtotals)

  // Running base the tax will be computed from: subtotal, then reduced by every
  // discount and (optionally) grown by the taxable service charge.
  let taxBase = subtotal
  // Running additive total: what the customer owes before tax/rounding. In
  // inclusive mode the tax is already inside these amounts, so it is never added.
  let runningTotal = subtotal

  // Step 2a — item discounts, each against its target line (§6.4).
  for (const disc of input.itemDiscounts ?? []) {
    const line = lineSubtotals[disc.lineIndex]
    if (line === undefined) {
      throw new Error(`Item discount "${disc.label}" targets missing line ${disc.lineIndex}.`)
    }
    const magnitude = discountMagnitude(disc, line)
    const amount = neg(magnitude)
    charges.push({
      kind: 'DISCOUNT',
      label: disc.label,
      basis: line,
      rateBp: disc.rateBp ?? null,
      amount,
      taxable: true,
      sortOrder: nextSort(),
    })
    taxBase = add(taxBase, amount)
    runningTotal = add(runningTotal, amount)
  }

  // Step 2b — order discounts, each against the running discounted subtotal.
  for (const disc of input.orderDiscounts ?? []) {
    const base = taxBase
    const magnitude = discountMagnitude(disc, base)
    const amount = neg(magnitude)
    charges.push({
      kind: 'DISCOUNT',
      label: disc.label,
      basis: base,
      rateBp: disc.rateBp ?? null,
      amount,
      taxable: true,
      sortOrder: nextSort(),
    })
    taxBase = add(taxBase, amount)
    runningTotal = add(runningTotal, amount)
  }

  const discountedSubtotal = taxBase

  // Step 3 — service charge, percent of the discounted subtotal.
  if (fiscal.serviceChargeRateBp > 0) {
    const serviceCharge = applyRate(discountedSubtotal, fiscal.serviceChargeRateBp)
    charges.push({
      kind: 'SERVICE_CHARGE',
      label: `Service charge ${(fiscal.serviceChargeRateBp / 100).toString()}%`,
      basis: discountedSubtotal,
      rateBp: fiscal.serviceChargeRateBp,
      amount: serviceCharge,
      taxable: serviceChargeTaxable,
      sortOrder: nextSort(),
    })
    runningTotal = add(runningTotal, serviceCharge)
    if (serviceChargeTaxable) {
      taxBase = add(taxBase, serviceCharge)
    }
  }

  // Step 4 — tax. Exclusive adds on top; inclusive extracts what is already inside.
  if (fiscal.taxRateBp > 0 && taxBase > ZERO) {
    if (fiscal.taxInclusive) {
      const { tax } = extractInclusiveTax(taxBase, fiscal.taxRateBp)
      charges.push({
        kind: 'TAX',
        label: `Tax ${(fiscal.taxRateBp / 100).toString()}% (incl.)`,
        basis: taxBase,
        rateBp: fiscal.taxRateBp,
        amount: tax,
        taxable: false,
        sortOrder: nextSort(),
      })
      // Inclusive: tax is a memo — the gross already carries it, so runningTotal
      // is unchanged.
    } else {
      const tax = applyRate(taxBase, fiscal.taxRateBp)
      charges.push({
        kind: 'TAX',
        label: `Tax ${(fiscal.taxRateBp / 100).toString()}%`,
        basis: taxBase,
        rateBp: fiscal.taxRateBp,
        amount: tax,
        taxable: false,
        sortOrder: nextSort(),
      })
      runningTotal = add(runningTotal, tax)
    }
  }

  // Step 5 — rounding, exactly once, on the running total.
  const { rounded, delta } = roundToIncrement(runningTotal, fiscal.roundingIncrement)
  if (delta !== ZERO) {
    charges.push({
      kind: 'ROUNDING',
      label: 'Rounding',
      basis: runningTotal,
      rateBp: null,
      amount: delta,
      taxable: false,
      sortOrder: nextSort(),
    })
  }

  // Step 6 — total.
  const total = rounded

  // Step 7 — gratuity, outside the total, never taxed.
  let amountDue = total
  const gratuity = input.gratuityMinor ?? 0n
  if (gratuity > 0n) {
    const amount = asMoney(gratuity)
    charges.push({
      kind: 'GRATUITY',
      label: 'Gratuity',
      basis: amount,
      rateBp: null,
      amount,
      taxable: false,
      sortOrder: nextSort(),
    })
    amountDue = add(total, amount)
  }

  return {
    subtotal,
    charges,
    total,
    amountDue,
    taxContributesToTotal: !fiscal.taxInclusive,
  }
}
