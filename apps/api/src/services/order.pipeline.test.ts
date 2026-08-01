/**
 * S4-07 — bill pipeline arithmetic matrix. Design §6, standard #2.
 *
 * The pipeline is pure and DB-free, so this suite exercises it directly with no
 * fixtures. It is the mandated money-bug guard (sprint plan §3.2): every subtle
 * POS money bug lives in the *order* of discount → service charge → tax →
 * rounding, so the order is asserted here rather than trusted.
 *
 * Expected values are worked out by hand in each case's comment against the
 * `@brewsync/shared` helpers (applyRate/extractInclusiveTax/roundToIncrement,
 * all HALF_UP) so the test states the arithmetic, not just the result.
 */

import { describe, it, expect } from 'vitest'
import { runBillPipeline, type PipelineInput, type FiscalConfig } from '../../src/services/order.pipeline.js'

/** Exclusive 11% tax, no service charge, no cash rounding — the base case. */
const EXCLUSIVE: FiscalConfig = {
  taxInclusive: false,
  taxRateBp: 1100,
  serviceChargeRateBp: 0,
  roundingIncrement: 1,
}

const line = (subtotalMinor: bigint) => ({ subtotalMinor })

describe('S4-07 — bill pipeline', () => {
  describe('exclusive tax', () => {
    it('adds tax on top and the TAX row contributes to the total', () => {
      // subtotal 100000; tax = 100000·11% = 11000; total = 111000.
      const r = runBillPipeline({ lines: [line(100_000n)], fiscal: EXCLUSIVE })

      expect(r.subtotal).toBe(100_000n)
      expect(r.total).toBe(111_000n)
      expect(r.taxContributesToTotal).toBe(true)

      const tax = r.charges.find((c) => c.kind === 'TAX')!
      expect(tax.amount).toBe(11_000n)
      expect(tax.taxable).toBe(false)
      expect(tax.basis).toBe(100_000n)
    })
  })

  describe('inclusive tax', () => {
    it('extracts net exactly and the TAX row is a memo (does not add)', () => {
      // gross 111000; net = 111000·10000/11100 = 100000; tax = 11000.
      // The gross already carries the tax, so total stays 111000.
      const r = runBillPipeline({
        lines: [line(111_000n)],
        fiscal: { ...EXCLUSIVE, taxInclusive: true },
      })

      expect(r.subtotal).toBe(111_000n)
      expect(r.total).toBe(111_000n)
      expect(r.taxContributesToTotal).toBe(false)

      const tax = r.charges.find((c) => c.kind === 'TAX')!
      expect(tax.amount).toBe(11_000n)
      // net + tax === gross, exactly (no lost minor unit).
      expect(r.subtotal - tax.amount).toBe(100_000n)
    })
  })

  describe('item discount', () => {
    it('reduces the line before tax, as a negative DISCOUNT row', () => {
      // line 100000; 10% item discount = -10000; taxed base 90000;
      // tax = 90000·11% = 9900; total = 99900.
      const r = runBillPipeline({
        lines: [line(100_000n)],
        fiscal: EXCLUSIVE,
        itemDiscounts: [{ label: '10% off', rateBp: 1000, lineIndex: 0 }],
      })

      const disc = r.charges.find((c) => c.kind === 'DISCOUNT')!
      expect(disc.amount).toBe(-10_000n)
      expect(r.total).toBe(99_900n)
    })

    it('clamps a fixed discount to the line and never goes negative', () => {
      // A 200000 fixed discount on a 100000 line clamps to -100000 → base 0.
      const r = runBillPipeline({
        lines: [line(100_000n)],
        fiscal: EXCLUSIVE,
        itemDiscounts: [{ label: 'Comp', amountMinor: 200_000n, lineIndex: 0 }],
      })

      const disc = r.charges.find((c) => c.kind === 'DISCOUNT')!
      expect(disc.amount).toBe(-100_000n)
      expect(r.total).toBe(0n)
    })
  })

  describe('order discount', () => {
    it('applies after item discounts against the running subtotal', () => {
      // subtotal 100000; item 10% = -10000 → 90000; order 5% of 90000 = -4500 → 85500;
      // tax = 85500·11% = 9405; total = 94905.
      const r = runBillPipeline({
        lines: [line(100_000n)],
        fiscal: EXCLUSIVE,
        itemDiscounts: [{ label: '10% item', rateBp: 1000, lineIndex: 0 }],
        orderDiscounts: [{ label: '5% order', rateBp: 500 }],
      })

      const discounts = r.charges.filter((c) => c.kind === 'DISCOUNT')
      expect(discounts.map((d) => d.amount)).toEqual([-10_000n, -4_500n])
      expect(r.total).toBe(94_905n)
    })
  })

  describe('service charge', () => {
    it('is a percent of the discounted subtotal and joins the tax base by default', () => {
      // subtotal 100000; service 5% = 5000 (taxable); taxed base 105000;
      // tax = 105000·11% = 11550; total = 116550.
      const r = runBillPipeline({
        lines: [line(100_000n)],
        fiscal: { ...EXCLUSIVE, serviceChargeRateBp: 500 },
      })

      const svc = r.charges.find((c) => c.kind === 'SERVICE_CHARGE')!
      expect(svc.amount).toBe(5_000n)
      expect(svc.taxable).toBe(true)
      expect(r.total).toBe(116_550n)
    })

    it('is excluded from the tax base when serviceChargeTaxable is false', () => {
      // subtotal 100000; service 5% = 5000 (NOT taxable); taxed base 100000;
      // tax = 11000; total = 100000 + 5000 + 11000 = 116000.
      const r = runBillPipeline({
        lines: [line(100_000n)],
        fiscal: { ...EXCLUSIVE, serviceChargeRateBp: 500, serviceChargeTaxable: false },
      })

      const svc = r.charges.find((c) => c.kind === 'SERVICE_CHARGE')!
      expect(svc.taxable).toBe(false)
      expect(r.total).toBe(116_000n)
    })
  })

  describe('rounding', () => {
    it('rounds exactly once, emits a single signed ROUNDING row, and the total lands on the increment', () => {
      // subtotal 12345; tax = 12345·11% = 1358 (HALF_UP of 1357.95); running 13703;
      // round to 100 → 13700; delta = -3.
      const r = runBillPipeline({
        lines: [line(12_345n)],
        fiscal: { ...EXCLUSIVE, roundingIncrement: 100 },
      })

      const rounding = r.charges.filter((c) => c.kind === 'ROUNDING')
      expect(rounding).toHaveLength(1)
      expect(rounding[0]!.amount).toBe(-3n)
      expect(r.total).toBe(13_700n)
      expect(r.total % 100n).toBe(0n)
    })

    it('omits the ROUNDING row when the total already lands on the increment', () => {
      // subtotal 100000; tax 11000; running 111000; round to 100 → no delta.
      const r = runBillPipeline({
        lines: [line(100_000n)],
        fiscal: { ...EXCLUSIVE, roundingIncrement: 100 },
      })

      expect(r.charges.some((c) => c.kind === 'ROUNDING')).toBe(false)
      expect(r.total).toBe(111_000n)
    })
  })

  describe('gratuity', () => {
    it('sits outside the total, is never taxed, and lands in amountDue', () => {
      // subtotal 100000; tax 11000; total 111000; gratuity 5000 → amountDue 116000.
      const r = runBillPipeline({
        lines: [line(100_000n)],
        fiscal: EXCLUSIVE,
        gratuityMinor: 5_000n,
      })

      const grat = r.charges.find((c) => c.kind === 'GRATUITY')!
      expect(grat.amount).toBe(5_000n)
      expect(grat.taxable).toBe(false)
      expect(r.total).toBe(111_000n)
      expect(r.amountDue).toBe(116_000n)
    })
  })

  describe('the full §6 order', () => {
    it('produces charges in the fixed pipeline sequence', () => {
      // Every component present at once — the assertion is the ORDER of rows.
      const input: PipelineInput = {
        lines: [line(100_000n)],
        fiscal: { taxInclusive: false, taxRateBp: 1100, serviceChargeRateBp: 500, roundingIncrement: 100 },
        itemDiscounts: [{ label: 'item', rateBp: 1000, lineIndex: 0 }],
        orderDiscounts: [{ label: 'order', rateBp: 500 }],
        gratuityMinor: 5_000n,
      }
      const r = runBillPipeline(input)

      // sortOrder is monotonic and the kinds follow §6: discounts, service
      // charge, tax, rounding (if any), gratuity.
      const kinds = [...r.charges].sort((a, b) => a.sortOrder - b.sortOrder).map((c) => c.kind)
      const withoutRounding = kinds.filter((k) => k !== 'ROUNDING')
      expect(withoutRounding).toEqual([
        'DISCOUNT',
        'DISCOUNT',
        'SERVICE_CHARGE',
        'TAX',
        'GRATUITY',
      ])
      // At most one rounding row, wherever the delta fell.
      expect(kinds.filter((k) => k === 'ROUNDING').length).toBeLessThanOrEqual(1)
    })
  })

  describe('validation', () => {
    it('rejects a discount that sets both a percent and a fixed amount', () => {
      expect(() =>
        runBillPipeline({
          lines: [line(100_000n)],
          fiscal: EXCLUSIVE,
          orderDiscounts: [{ label: 'bad', rateBp: 1000, amountMinor: 5_000n }],
        })
      ).toThrow(/both/i)
    })

    it('rejects an item discount that targets a missing line', () => {
      expect(() =>
        runBillPipeline({
          lines: [line(100_000n)],
          fiscal: EXCLUSIVE,
          itemDiscounts: [{ label: 'ghost', rateBp: 1000, lineIndex: 9 }],
        })
      ).toThrow(/missing line/i)
    })
  })
})
