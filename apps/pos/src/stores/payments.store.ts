/**
 * Payments store — server state for the settlement screen (S5-08).
 *
 * Wraps the payment API 1:1 (apps/api/src/routes/payment.routes.ts). Every
 * mutation returns the affected bill(s) — with the server-derived
 * `tendered`/`remaining` already folded on — so the store replaces its `bills`
 * with the server's answer. It never patches a bill or computes money locally:
 * the settlement math lives in the backend (standard #2), so the screen renders
 * exactly the balances the API produced.
 *
 * Follows the Zustand pattern of orders.store.ts: `methods` + `bills` + `busy` +
 * `error`; actions catch `ApiError` and expose its message. A settling tender may
 * flip the order to PAID server-side — the screen re-reads the order separately.
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type { Bill, PaymentMethod } from '../lib/types.ts'
import type { SplitBillInput } from '../lib/types.ts'

export interface AcceptTenderPayload {
  methodId: string
  /** Tender handed over, minor units as a decimal string (standard #2). */
  amountMinor: string
  refNo?: string
}

export interface RefundPayload {
  methodId: string
  amountMinor: string
  reason: string
  refNo?: string
}

interface PaymentsState {
  methods: PaymentMethod[]
  bills: Bill[]
  loading: boolean
  busy: boolean
  error: string | null

  loadMethods: () => Promise<void>
  loadBills: (orderId: string) => Promise<void>
  /** Split the order's single bill; replaces `bills` with the N new ones. */
  split: (orderId: string, input: SplitBillInput) => Promise<void>
  /** Accept one tender against a bill; returns the change given (minor string). */
  accept: (billId: string, input: AcceptTenderPayload) => Promise<string | null>
  refund: (billId: string, input: RefundPayload) => Promise<void>
  clear: () => void
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

/** Replace the matching bill in a list with the server's updated copy. */
function replaceBill(bills: Bill[], updated: Bill): Bill[] {
  return bills.map((b) => (b.id === updated.id ? updated : b))
}

export const usePaymentsStore = create<PaymentsState>((set, get) => ({
  methods: [],
  bills: [],
  loading: false,
  busy: false,
  error: null,

  loadMethods: async () => {
    try {
      const res = await apiRequest<{ methods: PaymentMethod[] }>('/payments/methods')
      set({ methods: res.methods })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  loadBills: async (orderId) => {
    set({ loading: true, error: null })
    try {
      const res = await apiRequest<{ bills: Bill[] }>(`/payments/orders/${orderId}/bills`)
      set({ bills: res.bills, loading: false })
    } catch (err) {
      set({ error: message(err), loading: false })
    }
  },

  split: async (orderId, input) => {
    set({ busy: true, error: null })
    try {
      const res = await apiRequest<{ bills: Bill[] }>(`/payments/orders/${orderId}/split`, {
        method: 'POST',
        body: input,
      })
      set({ bills: res.bills, busy: false })
    } catch (err) {
      set({ error: message(err), busy: false })
    }
  },

  accept: async (billId, input) => {
    set({ busy: true, error: null })
    try {
      const res = await apiRequest<{ bill: Bill }>(`/payments/bills/${billId}`, {
        method: 'POST',
        body: {
          methodId: input.methodId,
          amountMinor: input.amountMinor,
          ...(input.refNo ? { refNo: input.refNo } : {}),
        },
      })
      set({ bills: replaceBill(get().bills, res.bill), busy: false })
      // The change given is on the tender we just added — the last payment row.
      const last = res.bill.payments[res.bill.payments.length - 1]
      return last?.changeGiven ?? null
    } catch (err) {
      set({ error: message(err), busy: false })
      return null
    }
  },

  refund: async (billId, input) => {
    set({ busy: true, error: null })
    try {
      const res = await apiRequest<{ bill: Bill }>(`/payments/bills/${billId}/refund`, {
        method: 'POST',
        body: {
          methodId: input.methodId,
          amountMinor: input.amountMinor,
          reason: input.reason,
          ...(input.refNo ? { refNo: input.refNo } : {}),
        },
      })
      set({ bills: replaceBill(get().bills, res.bill), busy: false })
    } catch (err) {
      set({ error: message(err), busy: false })
    }
  },

  clear: () => set({ bills: [], error: null, busy: false, loading: false }),
}))
