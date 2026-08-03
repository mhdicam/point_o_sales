/**
 * S5-01/02/03 — payment settlement math. Design §7, standard #2.
 *
 * Pure and DB-free, so this suite drives `computeTender` directly with no
 * fixtures. It is the mandated money guard for payments (sprint plan §3.2):
 * change and settlement are where split-payment bugs hide, so the arithmetic is
 * asserted rather than trusted.
 */

import { describe, it, expect } from 'vitest'
import { computeTender, TenderError } from '../../src/services/payment.settle.js'

describe('S5 — payment settlement', () => {
  describe('single tender', () => {
    it('exact cash settles with no change', () => {
      const r = computeTender({
        billTotal: 50_000n,
        priorTendered: 0n,
        amount: 50_000n,
        methodCountsAsCash: true,
      })
      expect(r.changeGiven).toBe(0n)
      expect(r.settles).toBe(true)
    })

    it('over-tendered cash returns the difference as change and settles', () => {
      // Customer hands 100k for a 73k bill → 27k change.
      const r = computeTender({
        billTotal: 73_000n,
        priorTendered: 0n,
        amount: 100_000n,
        methodCountsAsCash: true,
      })
      expect(r.changeGiven).toBe(27_000n)
      expect(r.settles).toBe(true)
    })

    it('exact card payment settles with no change', () => {
      const r = computeTender({
        billTotal: 50_000n,
        priorTendered: 0n,
        amount: 50_000n,
        methodCountsAsCash: false,
      })
      expect(r.changeGiven).toBe(0n)
      expect(r.settles).toBe(true)
    })
  })

  describe('split payment (§7.2)', () => {
    it('a partial first tender does not settle and gives no change', () => {
      const r = computeTender({
        billTotal: 100_000n,
        priorTendered: 0n,
        amount: 40_000n,
        methodCountsAsCash: false,
      })
      expect(r.changeGiven).toBe(0n)
      expect(r.settles).toBe(false)
    })

    it('the settling cash tender carries the change on the remainder', () => {
      // 40k card already down; customer pays the 60k remainder with 100k cash.
      const r = computeTender({
        billTotal: 100_000n,
        priorTendered: 40_000n,
        amount: 100_000n,
        methodCountsAsCash: true,
      })
      expect(r.changeGiven).toBe(40_000n)
      expect(r.settles).toBe(true)
    })

    it('a card tender for exactly the remainder settles', () => {
      const r = computeTender({
        billTotal: 100_000n,
        priorTendered: 40_000n,
        amount: 60_000n,
        methodCountsAsCash: false,
      })
      expect(r.changeGiven).toBe(0n)
      expect(r.settles).toBe(true)
    })
  })

  describe('illegal tenders throw', () => {
    it('rejects a non-positive amount', () => {
      expect(() =>
        computeTender({ billTotal: 100n, priorTendered: 0n, amount: 0n, methodCountsAsCash: true })
      ).toThrow(TenderError)
    })

    it('rejects a tender against an already-settled bill', () => {
      expect(() =>
        computeTender({
          billTotal: 100n,
          priorTendered: 100n,
          amount: 50n,
          methodCountsAsCash: true,
        })
      ).toThrow(/already fully tendered/)
    })

    it('rejects a non-cash over-tender (no card change)', () => {
      expect(() =>
        computeTender({
          billTotal: 100n,
          priorTendered: 0n,
          amount: 150n,
          methodCountsAsCash: false,
        })
      ).toThrow(/no change to give|remaining amount/)
    })
  })
})
