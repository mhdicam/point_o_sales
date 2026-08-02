/**
 * Wire types for the two public QR endpoints (apps/api/src/routes/qr.routes.ts).
 *
 * Money fields cross the wire as decimal *strings* (standard #2): the API
 * serializes BigInt as a string, and typing prices as string keeps the no-float
 * rule visible at the type level. Parse with `money()` from @brewsync/shared
 * only at the edge where a preview is formatted — never coerce to a JS number.
 *
 * Hand-maintained against `QrOrderService` + the route response shapes rather
 * than generated, to keep this app free of a Prisma-client import.
 */

/** A product grouping row in the menu (from `QrOrderService.menu`). */
export interface QrMenuProduct {
  productId: string
  name: string
  categoryName: string | null
  coverImageUrl: string | null
}

/** A purchasable variant row with a resolved, outlet-scoped price. */
export interface QrMenuVariant {
  variantId: string
  productId: string
  name: string
  /** Minor units — decimal string (standard #2). */
  price: string
}

/** `GET /qr/:token` response. */
export interface QrMenuResponse {
  table: { name: string }
  outlet: { id: string }
  products: QrMenuProduct[]
  variants: QrMenuVariant[]
}

/** One line the customer wants to order. `modifierIds` is reserved for later. */
export interface QrOrderItemInput {
  variantId: string
  qty: number
  modifierIds?: string[]
}

/** Server-derived money summary echoed on the placed order (design §6). */
export interface QrOrderSummary {
  subtotal: string
  total: string
  amountDue: string
  taxContributesToTotal: boolean
}

/** The subset of the placed Order the confirmation screen renders. */
export interface QrPlacedOrder {
  id: string
  status: string
  channel: string
  tableId: string | null
  summary: QrOrderSummary
}

/** `POST /qr/:token/orders` response. `accepted` = the outlet auto-sent it. */
export interface QrPlaceOrderResponse {
  order: QrPlacedOrder
  accepted: boolean
}
