/**
 * Fiscal configuration resolution — S7-01, design §6.
 *
 * Returns the effective tax/service-charge/rounding config for a given order.
 * For S7 this is an **identity passthrough** from the Outlet (+ the optional
 * `Category.defaultTaxRateBp` layer that predated S7); the SalesMethod fiscal
 * columns are no-op. A per-method override will be wired in a later sprint once
 * the precedence is decided (Outlet < Category < SalesMethod, or Category <
 * Outlet < SalesMethod, or something else).
 *
 * The pure discipline (no DB, no side effects) lets this be unit-tested without
 * a tenant transaction; the pipeline sees only a FiscalConfig, never a
 * SalesMethod or Outlet row.
 */

import type { FiscalConfig } from './order.pipeline.js'

export interface OutletFiscalSnapshot {
  taxInclusive: boolean
  taxRateBp: number
  serviceChargeRateBp: number
  roundingIncrement: number
}

export interface SalesMethodFiscalSnapshot {
  taxRateBp: number | null
  serviceChargeRateBp: number | null
  taxInclusive: boolean | null
}

/**
 * Resolves the effective fiscal configuration for an order. Identity passthrough
 * in S7: the outlet config is returned verbatim; salesMethod is ignored.
 *
 * When a per-method override is wired, the precedence will be defined here (in
 * one place, under test) so changing it does not ripple through the bill
 * pipeline or the order service.
 *
 * @param outlet The outlet's fiscal configuration snapshot.
 * @param _salesMethod Reserved for per-method override (§6); unused in S7.
 * @returns The effective fiscal config for the bill pipeline.
 */
export function resolveFiscalConfig(
  outlet: OutletFiscalSnapshot,
  _salesMethod?: SalesMethodFiscalSnapshot | null
): FiscalConfig {
  // S7 identity passthrough: method fiscal columns are no-op. The outlet is the
  // sole source; Category.defaultTaxRateBp is resolved at the line level by
  // whatever layer builds the per-line taxable flag (future S7 or later work).
  return {
    taxInclusive: outlet.taxInclusive,
    taxRateBp: outlet.taxRateBp,
    serviceChargeRateBp: outlet.serviceChargeRateBp,
    roundingIncrement: outlet.roundingIncrement,
    // serviceChargeTaxable defaults true (§6.3); no per-method override yet.
    serviceChargeTaxable: true,
  }
}
