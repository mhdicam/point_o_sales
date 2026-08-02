/**
 * Purchase-orders store — S6-09. Server state for the PO lifecycle at the active
 * outlet: list, one open detail, and the lifecycle actions (create draft, submit,
 * approve, cancel, receive goods).
 *
 * Wraps the PO API 1:1 (apps/api/src/routes/purchase-order.routes.ts). The whole
 * router is gated on `features.purchasing`; reads + draft mutations need
 * `purchase.create`, approve/cancel need `purchase.approve`, receipt needs
 * `purchase.receive` — the backend is the security boundary (standard #5). Money
 * and quantities cross the wire as scaled decimal strings; the screen builds the
 * scaled `qtyOrderedScaled`/`unitCost`/`qtyScaled` values.
 *
 * Every mutation returns the changed PO; the store refetches the list and keeps
 * the open detail fresh rather than patching derived money locally (standard #7 —
 * the frozen totals are the server's to compute).
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type { PurchaseOrder, PurchaseOrderStatus } from '../lib/types.ts'

/** One draft line as the create form submits it (scaled/minor-unit strings). */
export interface PurchaseOrderLineInput {
  variantId: string
  /** Scaled base units (× 1e6) as a decimal string. */
  qtyOrderedScaled: string
  /** Minor units per one base unit as a decimal string. */
  unitCost?: string
  sortOrder?: number
}

export interface CreatePurchaseOrderInput {
  outletId: string
  supplierId: string
  expectedDate?: string | null
  taxRateBp?: number
  notes?: string | null
  items: PurchaseOrderLineInput[]
}

/** One receipt line: which PO line, how much physically arrived (scaled string). */
export interface ReceiveLineInput {
  poItemId: string
  qtyScaled: string
}

interface PurchaseOrdersState {
  outletId: string | null
  orders: PurchaseOrder[]
  /** The PO whose detail is open, with its lines + summary. */
  detail: PurchaseOrder | null
  loading: boolean
  loaded: boolean
  busy: boolean
  error: string | null

  /** Load the PO list for an outlet, optionally filtered by status. */
  load: (outletId: string, opts?: { status?: PurchaseOrderStatus }) => Promise<void>
  open: (poId: string) => Promise<void>
  closeDetail: () => void

  create: (input: CreatePurchaseOrderInput) => Promise<PurchaseOrder>
  submit: (poId: string) => Promise<PurchaseOrder>
  approve: (poId: string) => Promise<PurchaseOrder>
  cancel: (poId: string, reason: string) => Promise<PurchaseOrder>
  receive: (poId: string, lines: ReceiveLineInput[]) => Promise<PurchaseOrder>

  clear: () => void
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

export const usePurchaseOrdersStore = create<PurchaseOrdersState>((set, get) => ({
  outletId: null,
  orders: [],
  detail: null,
  loading: false,
  loaded: false,
  busy: false,
  error: null,

  load: async (outletId, opts = {}) => {
    set({ loading: true, error: null, outletId })
    try {
      const res = await apiRequest<{ purchaseOrders: PurchaseOrder[] }>('/purchase-orders', {
        query: { outletId, ...(opts.status ? { status: opts.status } : {}) },
      })
      set({ orders: res.purchaseOrders, loaded: true, loading: false })
    } catch (err) {
      set({ error: message(err), loading: false })
    }
  },

  open: async (poId) => {
    set({ error: null })
    try {
      const res = await apiRequest<{ purchaseOrder: PurchaseOrder }>(`/purchase-orders/${poId}`)
      set({ detail: res.purchaseOrder })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  closeDetail: () => set({ detail: null }),

  create: (input) =>
    mutate(set, get, async () => {
      const res = await apiRequest<{ purchaseOrder: PurchaseOrder }>('/purchase-orders', {
        method: 'POST',
        body: input,
      })
      return res.purchaseOrder
    }),

  submit: (poId) => transition(set, get, `/purchase-orders/${poId}/submit`),
  approve: (poId) => transition(set, get, `/purchase-orders/${poId}/approve`),

  cancel: (poId, reason) =>
    mutate(set, get, async () => {
      const res = await apiRequest<{ purchaseOrder: PurchaseOrder }>(
        `/purchase-orders/${poId}/cancel`,
        { method: 'POST', body: { reason } }
      )
      return res.purchaseOrder
    }),

  receive: (poId, lines) =>
    mutate(set, get, async () => {
      const res = await apiRequest<{ purchaseOrder: PurchaseOrder }>(
        `/purchase-orders/${poId}/receive`,
        { method: 'POST', body: { lines } }
      )
      return res.purchaseOrder
    }),

  clear: () => set({ outletId: null, orders: [], detail: null, loaded: false, error: null }),
}))

/** POST to a lifecycle endpoint that takes no body (submit/approve). */
function transition(
  set: (partial: Partial<PurchaseOrdersState>) => void,
  get: () => PurchaseOrdersState,
  path: string
): Promise<PurchaseOrder> {
  return mutate(set, get, async () => {
    const res = await apiRequest<{ purchaseOrder: PurchaseOrder }>(path, { method: 'POST' })
    return res.purchaseOrder
  })
}

/**
 * Runs a PO mutation: flips `busy`, refetches the list for the active outlet, and
 * refreshes the open detail if it is the changed PO. Keeps every action a
 * one-liner and the busy/error/refetch handling in one place.
 */
async function mutate(
  set: (partial: Partial<PurchaseOrdersState>) => void,
  get: () => PurchaseOrdersState,
  body: () => Promise<PurchaseOrder>
): Promise<PurchaseOrder> {
  set({ busy: true, error: null })
  try {
    const po = await body()
    const outletId = get().outletId
    if (outletId) await get().load(outletId)
    if (get().detail?.id === po.id) await get().open(po.id)
    set({ busy: false })
    return po
  } catch (err) {
    set({ error: message(err), busy: false })
    throw err
  }
}
