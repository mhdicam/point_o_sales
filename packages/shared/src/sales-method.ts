/**
 * Sales method — S7-01, design §6.
 *
 * How an order is fulfilled: dine-in, takeaway, or delivery. The kind is a fixed
 * platform vocabulary (behaviour keys off it the same way it keys off
 * ProductVariant.fulfillmentType — data, not vertical branches); the individual
 * SalesMethod rows are tenant-owned and referenced by `code`, not by these
 * constants.
 */

export const SALES_METHOD_KINDS = ['DINE_IN', 'TAKEAWAY', 'DELIVERY'] as const

export type SalesMethodKind = (typeof SALES_METHOD_KINDS)[number]

export function isSalesMethodKind(value: unknown): value is SalesMethodKind {
  return typeof value === 'string' && (SALES_METHOD_KINDS as readonly string[]).includes(value)
}
