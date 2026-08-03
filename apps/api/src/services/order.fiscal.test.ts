/**
 * order.fiscal.ts tests — S7-01.
 *
 * S7 contract: fiscal resolution is an identity passthrough from the outlet. The
 * SalesMethod fiscal columns are no-op, so passing any method (or none) must not
 * shift the returned config. These tests pin that contract so wiring a real
 * override later is a deliberate, test-changing act — no order's tax drifts by
 * accident.
 */

import { describe, expect, it } from 'vitest'
import { resolveFiscalConfig, type OutletFiscalSnapshot } from './order.fiscal.js'

const OUTLET: OutletFiscalSnapshot = {
  taxInclusive: false,
  taxRateBp: 1100,
  serviceChargeRateBp: 500,
  roundingIncrement: 100,
}

describe('resolveFiscalConfig', () => {
  it('returns the outlet config verbatim when no sales method is given', () => {
    expect(resolveFiscalConfig(OUTLET)).toEqual({
      taxInclusive: false,
      taxRateBp: 1100,
      serviceChargeRateBp: 500,
      roundingIncrement: 100,
      serviceChargeTaxable: true,
    })
  })

  it('ignores the sales method fiscal columns in S7 (no-op override)', () => {
    const withMethod = resolveFiscalConfig(OUTLET, {
      taxRateBp: 0,
      serviceChargeRateBp: 9999,
      taxInclusive: true,
    })
    expect(withMethod).toEqual(resolveFiscalConfig(OUTLET))
  })

  it('ignores a null-column sales method identically', () => {
    const withNullMethod = resolveFiscalConfig(OUTLET, {
      taxRateBp: null,
      serviceChargeRateBp: null,
      taxInclusive: null,
    })
    expect(withNullMethod).toEqual(resolveFiscalConfig(OUTLET))
  })

  it('preserves an inclusive-tax outlet unchanged', () => {
    const inclusive: OutletFiscalSnapshot = { ...OUTLET, taxInclusive: true }
    expect(resolveFiscalConfig(inclusive).taxInclusive).toBe(true)
  })
})
