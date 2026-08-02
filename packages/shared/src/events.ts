/**
 * Event type catalog — design §8.
 *
 * POS never calls Accounting (or anything else) directly. It writes an
 * `OutboxEvent` in the same transaction as the business change; subscribers
 * react. Event names live here so producer and consumer agree on the string.
 */

export const EVENT_TYPES = {
  // Sales
  SALE_COMPLETED: 'SaleCompleted',
  /** An order is created (§16.2) — used by QR/online self-service so a waiter
   * can see the pending order before it is accepted to the kitchen. */
  ORDER_CREATED: 'OrderCreated',
  ORDER_SENT: 'OrderSent',
  ORDER_VOIDED: 'OrderVoided',
  ITEM_VOIDED: 'ItemVoided',
  REFUND_ISSUED: 'RefundIssued',
  // Floor operations (§5.4)
  ORDER_TRANSFERRED: 'OrderTransferred',
  ORDER_MERGED: 'OrderMerged',
  ITEMS_MOVED: 'ItemsMoved',
  // Kitchen display (§5.5)
  KDS_ITEM_UPDATED: 'KdsItemUpdated',

  // Inventory
  STOCK_ADJUSTED: 'StockAdjusted',
  GOODS_RECEIVED: 'GoodsReceived',
  /** A PO reaches APPROVED (§4.5) — price/qty frozen, sent to the supplier. */
  PURCHASE_ORDER_APPROVED: 'PurchaseOrderApproved',
  /** Moving-average COGS for a sale (§4.3) — Accounting posts cost of goods sold. */
  COGS_RECORDED: 'CogsRecorded',

  // Reservation (§15)
  /** A booking is confirmed (§15.1) — a table/slot is held; a deposit may be taken. */
  RESERVATION_CONFIRMED: 'ReservationConfirmed',
  /** A confirmed booking is seated (§15.3) — it hands off to a live Order. */
  RESERVATION_SEATED: 'ReservationSeated',
  /** A confirmed booking did not arrive (§15.3) — deposit forfeited per policy. */
  RESERVATION_NO_SHOW: 'ReservationNoShow',
  /** A booking is cancelled before seating (§15.1). */
  RESERVATION_CANCELLED: 'ReservationCancelled',

  // Cash / shift
  SHIFT_OPENED: 'ShiftOpened',
  SHIFT_CLOSED: 'ShiftClosed',

  // Platform lifecycle
  TENANT_PROVISIONED: 'TenantProvisioned',
  USER_INVITED: 'UserInvited',
} as const

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES]

/**
 * Envelope shape. Payloads are self-contained snapshots (design §8.2) so a
 * consumer never has to query back into POS — that is what makes the decoupling
 * real rather than nominal.
 */
export interface EventEnvelope<TPayload = unknown> {
  id: string
  tenantId: string
  outletId: string | null
  type: EventType
  payload: TPayload
  occurredAt: Date
}
