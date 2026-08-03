/**
 * Order view-model — the tested seam between the wire `Order` and the cashier
 * screen (design §6/§7, S4-08).
 *
 * Two jobs, both pure so they can be unit-tested without React or a DB:
 *
 *   1. Shape for rendering. The API returns flat `items` + `charges` rows; the
 *      panel wants lines with their item-discounts attached, the order-level
 *      breakdown in `sortOrder`, and gratuity pulled out (it sits outside the
 *      total, §6 step 7). The money summary is already computed server-side — this
 *      only *formats* the decimal-string minor units for display via
 *      `minorToInput`. It never does money math (standard #2): no adding,
 *      no rate application, no rounding. Every number shown traces to a value the
 *      bill pipeline produced.
 *
 *   2. Answer "what is legal now" from the order status alone, mirroring the
 *      backend state machine (`order.state.ts`) and the pre-BILLED/pre-PAID guards
 *      in `order.service.ts`. These flags are status-legality only; the screen
 *      still ANDs each with a permission check (standard #5) before showing a
 *      control — the backend re-enforces both regardless.
 */

import { minorToInput } from './money-input.ts'
import type {
  Order,
  OrderChargeKind,
  OrderItem,
  OrderStatus,
} from './types.ts'

/** Statuses where the bill is still working state — discounts/gratuity/void-item are legal. */
const PRE_BILLED: ReadonlySet<OrderStatus> = new Set(['OPEN', 'SENT', 'SERVED'])
/** Statuses from which the whole order can still be voided (money not yet taken). */
const PRE_PAID: ReadonlySet<OrderStatus> = new Set(['OPEN', 'SENT', 'SERVED', 'BILLED'])

const STATUS_LABEL: Record<OrderStatus, string> = {
  OPEN: 'Open',
  SENT: 'Sent',
  SERVED: 'Served',
  BILLED: 'Billed',
  PAID: 'Paid',
  CLOSED: 'Closed',
  VOID: 'Void',
}

/** What the current status permits. Permissions are applied on top of these in the UI. */
export interface OrderActionFlags {
  /** Items can be added / re-quantified / removed (OPEN only — they freeze at SENT). */
  editItems: boolean
  /** OPEN → SENT: fire to the kitchen, freezing prices. */
  send: boolean
  /** SENT → SERVED. */
  serve: boolean
  /** SENT/SERVED → BILLED. */
  bill: boolean
  /** BILLED: a bill exists and can be settled — the payment screen is reachable. */
  pay: boolean
  /** Whole-order void, reachable until money is taken. */
  voidOrder: boolean
  /** Single-line void — the post-SENT correction path, legal while pre-BILLED. */
  voidItem: boolean
  /** Discounts and gratuity may be changed while pre-BILLED. */
  discount: boolean
  /** No further changes possible (BILLED with payment next sprint, or a terminal state). */
  frozen: boolean
}

/** One formatted money row derived from an `OrderCharge` (design §6.2). */
export interface ChargeLineView {
  id: string
  kind: OrderChargeKind
  label: string
  /** Formatted signed amount, e.g. "-10.00". */
  amount: string
  /** True when the amount reduces the bill (discount, or a negative rounding delta). */
  isCredit: boolean
}

export interface OrderLineView {
  id: string
  variantId: string
  /** Frozen `nameSnapshot` once SENT, else the resolved catalog name, else a stub. */
  name: string
  qty: number
  /** Formatted unit price incl. modifier deltas. */
  unitPrice: string
  /** Formatted unit × qty. */
  lineSubtotal: string
  modifiers: { name: string; priceDelta: string }[]
  /** Item-level discounts attached to this line. */
  discounts: ChargeLineView[]
}

export interface OrderView {
  status: OrderStatus
  statusLabel: string
  lines: OrderLineView[]
  /** Order-level breakdown in `sortOrder`: order discounts, service charge, tax, rounding. */
  breakdown: ChargeLineView[]
  /** Gratuity sits outside the total; null when none set. */
  gratuity: ChargeLineView | null
  subtotal: string
  total: string
  amountDue: string
  /** False in inclusive-tax mode, where the TAX row is a memo already inside the subtotal. */
  taxContributesToTotal: boolean
  isEmpty: boolean
  actions: OrderActionFlags
}

export interface BuildOrderViewOptions {
  /** Resolves a line's display name while OPEN (before `nameSnapshot` freezes). */
  nameByVariant?: Map<string, string>
  /** Minor-unit digits for formatting; defaults to 2 to match the admin screens. */
  minorUnitDigits?: number
}

export function orderActionFlags(status: OrderStatus): OrderActionFlags {
  return {
    editItems: status === 'OPEN',
    send: status === 'OPEN',
    serve: status === 'SENT',
    bill: status === 'SENT' || status === 'SERVED',
    pay: status === 'BILLED',
    voidOrder: PRE_PAID.has(status),
    voidItem: PRE_BILLED.has(status),
    discount: PRE_BILLED.has(status),
    frozen: !PRE_PAID.has(status),
  }
}

function lineName(item: OrderItem, names?: Map<string, string>): string {
  if (item.nameSnapshot.trim() !== '') return item.nameSnapshot
  return names?.get(item.variantId) ?? 'Item'
}

function toChargeLine(
  charge: { id: string; kind: OrderChargeKind; label: string; amount: string },
  digits: number
): ChargeLineView {
  return {
    id: charge.id,
    kind: charge.kind,
    label: charge.label,
    amount: minorToInput(charge.amount, digits),
    isCredit: charge.amount.trim().startsWith('-'),
  }
}

export function buildOrderView(order: Order, opts: BuildOrderViewOptions = {}): OrderView {
  const digits = opts.minorUnitDigits ?? 2
  const fmt = (minor: string): string => minorToInput(minor, digits)

  // Bucket item-level discounts by their line so each renders under its row.
  const itemDiscounts = new Map<string, ChargeLineView[]>()
  for (const charge of order.charges) {
    if (charge.kind === 'DISCOUNT' && charge.orderItemId !== null) {
      const list = itemDiscounts.get(charge.orderItemId) ?? []
      list.push(toChargeLine(charge, digits))
      itemDiscounts.set(charge.orderItemId, list)
    }
  }

  const lines: OrderLineView[] = order.items.map((item) => ({
    id: item.id,
    variantId: item.variantId,
    name: lineName(item, opts.nameByVariant),
    qty: item.qty,
    unitPrice: fmt(item.unitPrice),
    lineSubtotal: fmt(item.lineSubtotal),
    modifiers: (item.modifiersSnapshot ?? []).map((m) => ({
      name: m.name,
      priceDelta: fmt(m.priceDelta),
    })),
    discounts: itemDiscounts.get(item.id) ?? [],
  }))

  // Order-level breakdown, already sorted by the API. Item discounts render on
  // their line; gratuity is surfaced separately (it is outside the total).
  const breakdown: ChargeLineView[] = []
  let gratuity: ChargeLineView | null = null
  for (const charge of order.charges) {
    if (charge.kind === 'DISCOUNT' && charge.orderItemId !== null) continue
    if (charge.kind === 'GRATUITY') {
      gratuity = toChargeLine(charge, digits)
      continue
    }
    breakdown.push(toChargeLine(charge, digits))
  }

  return {
    status: order.status,
    statusLabel: STATUS_LABEL[order.status],
    lines,
    breakdown,
    gratuity,
    subtotal: fmt(order.summary.subtotal),
    total: fmt(order.summary.total),
    amountDue: fmt(order.summary.amountDue),
    taxContributesToTotal: order.summary.taxContributesToTotal,
    isEmpty: order.items.length === 0,
    actions: orderActionFlags(order.status),
  }
}
