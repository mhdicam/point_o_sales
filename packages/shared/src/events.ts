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
  ORDER_VOIDED: 'OrderVoided',
  ITEM_VOIDED: 'ItemVoided',
  REFUND_ISSUED: 'RefundIssued',

  // Inventory
  STOCK_ADJUSTED: 'StockAdjusted',
  GOODS_RECEIVED: 'GoodsReceived',

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
