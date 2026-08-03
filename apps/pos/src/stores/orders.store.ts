/**
 * Orders store — server state for the cashier order screen (S4-08).
 *
 * Wraps the order API 1:1 (apps/api/src/routes/order.routes.ts). Every mutation
 * returns the full order — items + the pipeline's `OrderCharge` breakdown — so the
 * store simply replaces `current` with the server's answer. It never patches the
 * order or computes money locally: the bill pipeline is the single source of
 * truth (standard #2, design §6.2), and the panel always renders exactly the rows
 * the backend produced.
 *
 * Follows the Zustand-only pattern of products.store.ts: `current` + `loading` +
 * `error`, actions catch `ApiError` and expose its message. Illegal transitions
 * and frozen-order edits arrive as HTTP 409 and surface the same way.
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type { Order } from '../lib/types.ts'

/** A discount is exactly one of a percent (basis points) or a fixed amount. */
export interface DiscountPayload {
  label: string
  rateBp?: number
  /** Fixed amount in minor units, as a decimal string (standard #2). */
  amountMinor?: string
}

export interface AddItemPayload {
  variantId: string
  qty: number
  modifierIds?: string[]
}

/** A charge the server dropped during a merge, surfaced so the UI can warn. */
export interface MergeWarning {
  kind: 'ORDER_DISCOUNT_DROPPED' | 'GRATUITY_DROPPED'
  label: string
  /** Signed minor-unit amount, decimal string (standard #2). */
  amount: string
}

interface OrdersState {
  current: Order | null
  loading: boolean
  /** True while a mutation is in flight — used to disable action buttons. */
  busy: boolean
  error: string | null

  create: (input: {
    outletId: string
    salesMethod?: string | null
    items?: AddItemPayload[]
  }) => Promise<Order>
  getById: (id: string) => Promise<void>
  addItem: (item: AddItemPayload) => Promise<void>
  changeItemQty: (itemId: string, qty: number) => Promise<void>
  removeItem: (itemId: string) => Promise<void>
  applyItemDiscount: (itemId: string, discount: DiscountPayload) => Promise<void>
  applyOrderDiscount: (discount: DiscountPayload) => Promise<void>
  setGratuity: (gratuityMinor: string) => Promise<void>
  send: () => Promise<void>
  markServed: () => Promise<void>
  bill: () => Promise<void>
  voidOrder: () => Promise<void>
  voidItem: (itemId: string) => Promise<void>
  /** Floor operations (§5.4). Move the current order to another table. */
  transfer: (targetTableId: string) => Promise<void>
  /**
   * Merge another order into the current one. The absorbed order's items travel;
   * its order-level discount and gratuity are dropped — returned as `warnings` so
   * the caller can tell the cashier.
   */
  merge: (absorbedOrderId: string) => Promise<MergeWarning[]>
  /** Move a subset of the current order's items onto another order. */
  moveItems: (toOrderId: string, orderItemIds: string[]) => Promise<void>
  /** Drop the working order (after billing, or to start a fresh sale). */
  clear: () => void
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

export const useOrdersStore = create<OrdersState>((set, get) => ({
  current: null,
  loading: false,
  busy: false,
  error: null,

  create: async (input) => {
    set({ busy: true, error: null })
    try {
      const res = await apiRequest<{ order: Order }>('/orders', {
        method: 'POST',
        body: input,
      })
      set({ current: res.order, busy: false })
      return res.order
    } catch (err) {
      set({ error: message(err), busy: false })
      throw err
    }
  },

  getById: async (id) => {
    set({ loading: true, error: null })
    try {
      const res = await apiRequest<{ order: Order }>(`/orders/${id}`)
      set({ current: res.order, loading: false })
    } catch (err) {
      set({ error: message(err), loading: false })
    }
  },

  addItem: (item) => mutate(set, get, (id) => `/orders/${id}/items`, 'POST', item),

  changeItemQty: (itemId, qty) =>
    mutate(set, get, (id) => `/orders/${id}/items/${itemId}`, 'PUT', { qty }),

  removeItem: (itemId) =>
    mutate(set, get, (id) => `/orders/${id}/items/${itemId}`, 'DELETE'),

  applyItemDiscount: (itemId, discount) =>
    mutate(set, get, (id) => `/orders/${id}/items/${itemId}/discount`, 'POST', discount),

  applyOrderDiscount: (discount) =>
    mutate(set, get, (id) => `/orders/${id}/discount`, 'POST', discount),

  setGratuity: (gratuityMinor) =>
    mutate(set, get, (id) => `/orders/${id}/gratuity`, 'PUT', { gratuityMinor }),

  send: () => mutate(set, get, (id) => `/orders/${id}/send`, 'POST'),
  markServed: () => mutate(set, get, (id) => `/orders/${id}/serve`, 'POST'),
  bill: () => mutate(set, get, (id) => `/orders/${id}/bill`, 'POST'),
  voidOrder: () => mutate(set, get, (id) => `/orders/${id}/void`, 'POST'),
  voidItem: (itemId) => mutate(set, get, (id) => `/orders/${id}/items/${itemId}/void`, 'POST'),

  transfer: (targetTableId) =>
    mutate(set, get, (id) => `/orders/${id}/transfer`, 'POST', { targetTableId }),

  merge: async (absorbedOrderId) => {
    const order = get().current
    if (!order) {
      set({ error: 'No active order.' })
      return []
    }
    set({ busy: true, error: null })
    try {
      const res = await apiRequest<{ order: Order; warnings: MergeWarning[] }>(
        `/orders/${order.id}/merge`,
        { method: 'POST', body: { absorbedOrderId } }
      )
      set({ current: res.order, busy: false })
      return res.warnings
    } catch (err) {
      set({ error: message(err), busy: false })
      return []
    }
  },

  moveItems: async (toOrderId, orderItemIds) => {
    const order = get().current
    if (!order) {
      set({ error: 'No active order.' })
      return
    }
    set({ busy: true, error: null })
    try {
      // Response carries both orders; `current` is the source (`from`).
      const res = await apiRequest<{ from: Order; to: Order }>(
        `/orders/${order.id}/move-items`,
        { method: 'POST', body: { toOrderId, orderItemIds } }
      )
      set({ current: res.from, busy: false })
    } catch (err) {
      set({ error: message(err), busy: false })
    }
  },

  clear: () => set({ current: null, error: null, busy: false }),
}))

/**
 * Shared mutation runner: needs an active order, posts to its route, replaces
 * `current` with the returned order, and translates failures to `error`. Keeps
 * every action a one-liner and the busy/error handling in one place.
 */
async function mutate(
  set: (partial: Partial<OrdersState>) => void,
  get: () => OrdersState,
  path: (orderId: string) => string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown
): Promise<void> {
  const order = get().current
  if (!order) {
    set({ error: 'No active order.' })
    return
  }
  set({ busy: true, error: null })
  try {
    const res = await apiRequest<{ order: Order }>(path(order.id), {
      method,
      ...(body !== undefined ? { body } : {}),
    })
    set({ current: res.order, busy: false })
  } catch (err) {
    set({ error: message(err), busy: false })
  }
}
