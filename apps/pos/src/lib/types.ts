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

export type SalesMethodKind = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'

/**
 * How an order is fulfilled (design §6). Orders reference it by `code`. The
 * fiscal fields are reserved (no-op in S7) — tax/service charge still come from
 * the outlet — so the FE never reads them for money.
 */
export interface SalesMethod {
  id: string
  code: string
  name: string
  kind: SalesMethodKind
  taxRateBp: number | null
  serviceChargeRateBp: number | null
  taxInclusive: boolean | null
  isActive: boolean
  sortOrder: number
}

// ---- Floor plan (S7-02, design §5.4) ----

export type AreaKind = 'AREA' | 'FLOOR'

/** A node in the floor-plan hierarchy. FLOOR = top-level; AREA = nested section. */
export interface Area {
  id: string
  outletId: string
  parentId: string | null
  kind: AreaKind
  name: string
  sortOrder: number
  isActive: boolean
}

export type TableStatus = 'EMPTY' | 'OCCUPIED' | 'RESERVED' | 'DIRTY'

/**
 * A physical table. `status` is a small state machine (server-enforced). `qrToken`
 * is the self-service order token (§16.2) — the FE only needs it to build a QR link,
 * never to identify the table in the UI (that's `code`/`name`).
 */
export interface Table {
  id: string
  outletId: string
  areaId: string | null
  code: string
  name: string
  status: TableStatus
  capacity: number | null
  qrToken: string
  sortOrder: number
  isActive: boolean
}

// ---- Order (S4) ----

// ---- KDS stations (S7-04, design §5.5) ----

/**
 * A kitchen prep station (Bar, Kitchen, …). Outlet-owned master data; a routed
 * order line is grouped onto one at SENT. Only surfaces when `features.kds` is on.
 */
export interface Station {
  id: string
  outletId: string
  name: string
  sortOrder: number
  isActive: boolean
}

// ---- KDS board (S7-04/05, design §5.5) ----

export type KdsStatus = 'QUEUED' | 'PREPARING' | 'READY' | 'SERVED' | 'VOID'

/** A frozen modifier on a KDS ticket line (subset of OrderItemModifier). */
export interface KdsTicketModifier {
  modifierId: string
  name: string
  priceDelta: string
}

/**
 * One routed order line as the kitchen board sees it (design §5.5). The line
 * *is* the ticket — there is no separate KDS table. `stationId` is null for an
 * unrouted made-to-order line, surfaced on its own lane rather than dropped.
 */
export interface KdsTicket {
  id: string
  orderId: string
  stationId: string | null
  kdsStatus: KdsStatus
  qty: number
  nameSnapshot: string
  modifiersSnapshot: KdsTicketModifier[] | null
  createdAt: string
  order: { channel: OrderChannel; tableId: string | null }
}

/** The board projection returned by GET /kds/board. */
export interface KdsBoard {
  stations: { id: string; name: string }[]
  tickets: KdsTicket[]
}

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
  /** Seated table (§5.4), when `features.tables` is on. Null for takeaway/delivery/retail/service. */
  tableId: string | null
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

/**
 * A vendor (design §4.4, S6-05). Master data shared across every outlet; PO
 * lines reference it. `code` is the fast-lookup handle, frozen after create.
 * Per-item buy prices are NOT here — they live on PO lines (they move every
 * transaction). Deactivated, never deleted, so historical POs still resolve.
 */
export interface Supplier {
  id: string
  code: string
  name: string
  contactName: string | null
  phone: string | null
  email: string | null
  address: string | null
  /** NPWP — input-tax invoice. */
  taxId: string | null
  /** 0 = cash, 30 = net-30. */
  paymentTermDays: number
  defaultCurrency: string
  isActive: boolean
  notes: string | null
}

// ---- Inventory (S6-01/04, design §4) ----

export type StockMovementType =
  | 'ADJUSTMENT'
  | 'WASTE'
  | 'TRANSFER'
  | 'PRODUCTION'
  | 'SALE_CONSUMPTION'
  | 'PURCHASE'

/**
 * On-hand + valuation for one variant at one outlet, folded from the ledger
 * (§4.3, standard #3). Every figure is server-derived — the FE renders, never
 * sums. Quantities are scaled (base or stock unit × 1e6); money is minor units.
 * All BigInt → decimal string on the wire.
 */
export interface OnHand {
  variantId: string
  outletId: string
  /** On-hand in scaled base units (SUM of the ledger). Decimal string. */
  onHandBaseScaled: string
  /** On-hand in the variant's stock unit, scaled. What the FE displays. */
  onHandStockScaled: string
  /** Moving-average cost per one base unit, minor units. Decimal string. */
  avgCost: string
  /** Inventory value, minor units. Decimal string. */
  value: string
}

/** Outlet-wide valuation: the grand total plus one on-hand line per variant. */
export interface OutletValuation {
  outletId: string
  /** SUM of every variant's value, minor units. Decimal string. */
  totalValue: string
  /** Per-variant on-hand + value, highest value first. */
  lines: OnHand[]
}

/** One append-only stock ledger row (audit/inventory-card view). */
export interface StockMovement {
  id: string
  outletId: string
  variantId: string
  type: StockMovementType
  /** Signed scaled base units. Decimal string. */
  qty: string
  /** Minor units per one base unit at the movement, or null. Decimal string. */
  costPerUnit: string | null
  refType: string | null
  refId: string | null
  reason: string | null
  createdAt: string
}

// ---- Purchase order (S6-06/07/08, design §4.5) ----

export type PurchaseOrderStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'RECEIVING'
  | 'RECEIVED'
  | 'CLOSED'
  | 'CANCELLED'

/**
 * One PO line. `qtyOrderedScaled`/`qtyReceivedScaled` are scaled base units
 * (× 1e6); `unitCost`/`lineTotal` are minor units. `lineTotalPreview` is the
 * server's live extendedCost while DRAFT and equals the frozen `lineTotal` once
 * APPROVED. All BigInt → decimal string.
 */
export interface PurchaseOrderItem {
  id: string
  poId: string
  variantId: string
  qtyOrderedScaled: string
  qtyReceivedScaled: string
  unitCost: string
  lineTotal: string
  lineTotalPreview: string
  sortOrder: number
}

/** The server's derived money summary for a PO (minor units, decimal strings). */
export interface PurchaseOrderSummary {
  subtotal: string
  taxAmount: string
  total: string
}

/**
 * A purchase order with its lines. Header money (`subtotal/taxAmount/total`) is
 * frozen at APPROVED (standard #7); before then `summary` previews it from the
 * current lines. `summary`/`lineTotalPreview` are present on the detail read
 * (getById) but not on list rows.
 */
export interface PurchaseOrder {
  id: string
  outletId: string
  supplierId: string
  poNumber: number
  status: PurchaseOrderStatus
  expectedDate: string | null
  subtotal: string
  taxAmount: string
  total: string
  taxRateBp: number
  notes: string | null
  cancelReason: string | null
  approvedByUserId: string | null
  approvedAt: string | null
  createdAt: string
  updatedAt: string
  items: PurchaseOrderItem[]
  summary?: PurchaseOrderSummary
}

// --- Landing CMS (S9-02, design §17.1) -------------------------------------

export type LandingSectionType =
  | 'HERO'
  | 'CATALOG'
  | 'ABOUT'
  | 'GALLERY'
  | 'CONTACT'
  | 'HOURS'
  | 'MAP'
  | 'CUSTOM'

export type LandingPageStatus = 'DRAFT' | 'PUBLISHED'

/** `content` is a free-form object per type; CATALOG carries id references. */
export interface LandingSection {
  id: string
  type: LandingSectionType
  position: number
  title: string | null
  content: Record<string, unknown>
  isVisible: boolean
}

export interface LandingPage {
  id: string
  slug: string
  title: string
  description: string | null
  theme: Record<string, unknown> | null
  orderingEnabled: boolean
  status: LandingPageStatus
  publishedAt: string | null
  updatedAt: string
  sections: LandingSection[]
}
