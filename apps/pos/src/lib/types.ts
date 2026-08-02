/**
 * Wire types — the shapes the API actually returns.
 *
 * Money and factor fields are `string`, not `number`: the API serializes BigInt
 * as a decimal string (standard #2), and typing them as string keeps the
 * no-float rule enforced by the compiler. Parse with `money()` at the edge only
 * when arithmetic or formatting is needed.
 *
 * These are hand-maintained against the Prisma models + route responses rather
 * than generated, to avoid coupling the FE build to a Prisma client import.
 */

import type { FulfillmentType } from '@brewsync/shared'

// ---- Session / auth ----

export interface AuthUser {
  id: string
  email: string
  name: string
}

export interface MembershipOutlet {
  id: string
  name: string
}

export interface Membership {
  id: string
  tenant: { id: string; name: string; slug: string }
  outlets: MembershipOutlet[]
}

export interface Scope {
  tenantId: string
  outletId?: string
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

// ---- Master data ----

export interface Category {
  id: string
  name: string
  slug: string
  parentId: string | null
  sortOrder: number
  isActive: boolean
  defaultTaxRateBp: number | null
  defaultStationId: string | null
  reportGroup: string | null
}

export type UnitDimension = 'COUNT' | 'WEIGHT' | 'VOLUME' | 'LENGTH' | 'TIME'

export interface Unit {
  id: string
  code: string
  name: string
  dimension: UnitDimension
  baseUnitId: string | null
  /** BigInt scaled by 1e6 — decimal string on the wire. */
  factor: string
  isActive: boolean
}

export interface ProductImage {
  id: string
  url: string
  alt: string | null
  isCover: boolean
  sortOrder: number
}

export interface ProductVariant {
  id: string
  sku: string
  name: string
  barcode: string | null
  /** Minor units — decimal string. */
  basePrice: string
  fulfillmentType: FulfillmentType | null
  sellUnitId: string | null
  stockUnitId: string | null
  serviceDurationMin: number | null
  isDefault: boolean
  isActive: boolean
  sortOrder: number
}

export interface Product {
  id: string
  categoryId: string | null
  name: string
  slug: string
  description: string | null
  fulfillmentType: FulfillmentType
  isActive: boolean
  sortOrder: number
  variants: ProductVariant[]
  images: ProductImage[]
}

/** List endpoint returns a lighter product (variants/images may be summarized). */
export interface ProductListItem {
  id: string
  categoryId: string | null
  name: string
  slug: string
  fulfillmentType: FulfillmentType
  isActive: boolean
  sortOrder: number
  variants: ProductVariant[]
  images: ProductImage[]
}

export interface ModifierOption {
  id: string
  name: string
  /** Signed minor units — decimal string. */
  priceDelta: string
  isDefault: boolean
  isActive: boolean
  sortOrder: number
}

export interface ModifierGroup {
  id: string
  name: string
  minSelect: number
  maxSelect: number | null
  isRequired: boolean
  isActive: boolean
  sortOrder: number
  modifiers: ModifierOption[]
}

export interface PriceList {
  id: string
  name: string
  outletId: string | null
  salesMethod: string | null
  priority: number
  validFrom: string | null
  validTo: string | null
  isActive: boolean
}

// ---- Order (S4) ----

export type OrderStatus = 'OPEN' | 'SENT' | 'SERVED' | 'BILLED' | 'PAID' | 'CLOSED' | 'VOID'

export type OrderChannel = 'STAFF' | 'QR_TABLE' | 'ONLINE'

export type OrderChargeKind =
  | 'DISCOUNT'
  | 'SERVICE_CHARGE'
  | 'TAX'
  | 'ROUNDING'
  | 'GRATUITY'

/** One frozen modifier on a line, as stored in `modifiersSnapshot`. */
export interface OrderItemModifier {
  modifierId: string
  name: string
  /** Signed minor units — decimal string. */
  priceDelta: string
}

export interface OrderItem {
  id: string
  variantId: string
  qty: number
  /** Frozen at SENT; "0" while OPEN. Minor units — decimal string. */
  priceSnapshot: string
  /** Frozen at SENT; "" while OPEN. */
  nameSnapshot: string
  /** Sum of chosen modifier deltas, frozen at SENT. Minor units — decimal string. */
  modifierDeltaSnapshot: string
  /** Chosen modifiers, frozen at SENT. Null until then. */
  modifiersSnapshot: OrderItemModifier[] | null
  /**
   * Server-derived display price for the line (unit incl. modifiers, and unit ×
   * qty), so the panel can show prices while OPEN before snapshots freeze. Minor
   * units — decimal string. Computed by the same pipeline that persists charges,
   * never on the client (standard #2).
   */
  unitPrice: string
  lineSubtotal: string
}

/**
 * Server-derived money summary for the order (design §6). Re-run from the pure
 * pipeline on every read so the FE renders — never computes — the total. Minor
 * units as decimal strings. `taxContributesToTotal` is false in inclusive-tax
 * mode, where the TAX charge is a memo already inside the subtotal.
 */
export interface OrderSummary {
  subtotal: string
  total: string
  amountDue: string
  taxContributesToTotal: boolean
}

/**
 * One persisted component of the bill breakdown (design §6.2). `amount` is signed
 * minor units (discounts negative); `basis` is what a rate applied to; `rateBp`
 * is basis points (1100 = 11%) or null for flat rows. Rendered directly — the
 * client never recomputes money (standard #2).
 */
export interface OrderCharge {
  id: string
  kind: OrderChargeKind
  label: string
  basis: string
  rateBp: number | null
  amount: string
  taxable: boolean
  sortOrder: number
  orderItemId: string | null
}

export interface Order {
  id: string
  outletId: string
  status: OrderStatus
  channel: OrderChannel
  salesMethod: string | null
  sentAt: string | null
  billedAt: string | null
  createdAt: string
  updatedAt: string
  items: OrderItem[]
  charges: OrderCharge[]
  summary: OrderSummary
}

// ---- Payment / Bill (S5, design §7) ----

export type PaymentMethodKind = 'CASH' | 'CARD' | 'EWALLET' | 'TRANSFER' | 'VOUCHER' | 'OTHER'

export interface PaymentMethod {
  id: string
  code: string
  name: string
  kind: PaymentMethodKind
  /** Kicks the cash drawer on accept (§7.5). */
  opensCashDrawer: boolean
  /** Requires a reference number (card approval, QRIS txn id) at capture. */
  needsRefNo: boolean
  /** Only these tenders move the shift cash drawer (§14.2). */
  countsAsCash: boolean
  isActive: boolean
  sortOrder: number
}

export type BillStatus = 'OPEN' | 'PAID' | 'VOID'

/**
 * How to split one order's single bill (§7.3): an even N-way split or explicit
 * weights (minor-unit decimal strings — standard #2). Mirrors the API's
 * `splitSchema`.
 */
export type SplitBillInput =
  | { mode: 'even'; parts: number }
  | { mode: 'weights'; weights: string[] }

/** One tender against a bill. `amount` positive = payment, negative = refund (§7.4). */
export interface Payment {
  id: string
  billId: string
  methodId: string
  /** Signed minor units — decimal string. */
  amount: string
  /** Cash handed back on an over-tender. Minor units — decimal string. */
  changeGiven: string
  refNo: string | null
  reason: string | null
  createdAt: string
}

/**
 * A bill with its tenders and the server-derived balances. `tendered` and
 * `remaining` are computed by the API (SUM over payments — standard #2/#3); the
 * FE renders them, never sums locally.
 */
export interface Bill {
  id: string
  orderId: string
  seq: number
  status: BillStatus
  /** Minor units — decimal string. */
  subtotal: string
  total: string
  label: string | null
  paidAt: string | null
  payments: Payment[]
  /** SUM(payment.amount), minor units — decimal string. */
  tendered: string
  /** max(total − tendered, 0), minor units — decimal string. */
  remaining: string
}

// ---- Shift / cash drawer (S5, design §14) ----

export type ShiftStatus = 'OPEN' | 'CLOSED'

export type CashMovementType =
  | 'OPENING_FLOAT'
  | 'CASH_SALE'
  | 'CASH_REFUND'
  | 'PAID_IN'
  | 'PAID_OUT'
  | 'DROP'

/** One append-only drawer ledger row. `amount` sign matches the type (§14.2). */
export interface CashMovement {
  id: string
  shiftId: string
  type: CashMovementType
  /** Signed minor units — decimal string. */
  amount: string
  refType: string | null
  refId: string | null
  reason: string | null
  createdAt: string
}

/**
 * A till session. The drawer balance and reconciliation figures are all
 * server-derived (§14, standard #3): `drawerBalance` = SUM(movements), and the
 * expected/variance fields freeze at close. The FE renders them, never sums.
 */
export interface Shift {
  id: string
  outletId: string
  registerId: string | null
  openedByUserId: string
  /** Minor units — decimal string. */
  openingFloat: string
  openedAt: string
  closedByUserId: string | null
  closingCountedCash: string | null
  expectedCash: string | null
  /** closingCountedCash − expectedCash (signed); negative = short. */
  cashVariance: string | null
  closedAt: string | null
  status: ShiftStatus
  movements: CashMovement[]
  /** SUM(movements.amount), minor units — decimal string. */
  drawerBalance: string
}
