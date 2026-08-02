/**
 * S7-03 — Floor-operation policy unit tests.
 *
 * The pure, DB-free decisions behind merge. The one deliberate money decision
 * is the **merge drop policy**: item discounts travel with their line, but
 * order-level discount + gratuity are dropped (their basis — the subtotal or
 * total — no longer exists after the merge).
 */

import { describe, it, expect } from 'vitest'
import { classifyMergeCharges, type MergeChargeRow } from '../../src/services/table-ops.policy.js'

describe('S7-03 — Merge charge classification', () => {
  it('carries item discounts (orderItemId set)', () => {
    const charges: MergeChargeRow[] = [
      { kind: 'DISCOUNT', label: 'Disc 1', amount: '-5000', orderItemId: 'item1' },
      { kind: 'DISCOUNT', label: 'Disc 2', amount: '-2000', orderItemId: 'item2' },
    ]
    const result = classifyMergeCharges(charges)
    expect(result.itemDiscountIds).toEqual(['item1', 'item2'])
    expect(result.warnings).toEqual([])
  })

  it('drops order-level discounts (orderItemId null) with warning', () => {
    const charges: MergeChargeRow[] = [
      { kind: 'DISCOUNT', label: '10% off', amount: '-10000', orderItemId: null },
    ]
    const result = classifyMergeCharges(charges)
    expect(result.itemDiscountIds).toEqual([])
    expect(result.warnings).toEqual([
      { kind: 'ORDER_DISCOUNT_DROPPED', label: '10% off', amount: '-10000' },
    ])
  })

  it('drops gratuity with warning', () => {
    const charges: MergeChargeRow[] = [
      { kind: 'GRATUITY', label: 'Gratuity', amount: '5000', orderItemId: null },
    ]
    const result = classifyMergeCharges(charges)
    expect(result.itemDiscountIds).toEqual([])
    expect(result.warnings).toEqual([
      { kind: 'GRATUITY_DROPPED', label: 'Gratuity', amount: '5000' },
    ])
  })

  it('ignores derived charges (SERVICE_CHARGE / TAX / ROUNDING)', () => {
    const charges: MergeChargeRow[] = [
      { kind: 'SERVICE_CHARGE', label: 'SC 5%', amount: '2500', orderItemId: null },
      { kind: 'TAX', label: 'PB1 10%', amount: '5000', orderItemId: null },
      { kind: 'ROUNDING', label: 'Rounding', amount: '100', orderItemId: null },
    ]
    const result = classifyMergeCharges(charges)
    expect(result.itemDiscountIds).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('mixed case: carries item discounts, drops order discount + gratuity, ignores derived', () => {
    const charges: MergeChargeRow[] = [
      { kind: 'DISCOUNT', label: 'Item disc 1', amount: '-3000', orderItemId: 'item1' },
      { kind: 'DISCOUNT', label: 'Order disc 20%', amount: '-15000', orderItemId: null },
      { kind: 'SERVICE_CHARGE', label: 'SC 5%', amount: '2000', orderItemId: null },
      { kind: 'TAX', label: 'PB1 10%', amount: '4000', orderItemId: null },
      { kind: 'GRATUITY', label: 'Tip', amount: '10000', orderItemId: null },
      { kind: 'DISCOUNT', label: 'Item disc 2', amount: '-1000', orderItemId: 'item2' },
    ]
    const result = classifyMergeCharges(charges)
    expect(result.itemDiscountIds).toEqual(['item1', 'item2'])
    expect(result.warnings).toEqual([
      { kind: 'ORDER_DISCOUNT_DROPPED', label: 'Order disc 20%', amount: '-15000' },
      { kind: 'GRATUITY_DROPPED', label: 'Tip', amount: '10000' },
    ])
  })
})
