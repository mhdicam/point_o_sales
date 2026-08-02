/**
 * QR order store — server + cart state for the customer ordering flow (S8-08).
 *
 * Wraps the two public QR endpoints (apps/api/src/routes/qr.routes.ts) 1:1 and
 * holds the client-side cart. It never computes an authoritative amount — the
 * menu prices are display strings and the payable total comes back from the
 * server on placement (standard #2, design §6). Follows the Zustand-only pattern
 * of the POS stores: server state + `loading`/`error`, actions catch `ApiError`
 * and expose its `code`/`message` so screens can branch (QR_INVALID → not-found,
 * QR_RATE_LIMITED → retry hint).
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import { setCartQty } from '../lib/cart-view.ts'
import type { QrMenuResponse, QrOrderItemInput, QrPlaceOrderResponse } from '../lib/qr-types.ts'

interface QrState {
  token: string | null
  menu: QrMenuResponse | null
  cart: QrOrderItemInput[]
  placed: QrPlaceOrderResponse | null

  loading: boolean
  placing: boolean
  /** Error code from the API (branchable) — e.g. QR_INVALID, QR_RATE_LIMITED. */
  errorCode: string | null
  errorMessage: string | null

  loadMenu: (token: string) => Promise<void>
  setQty: (variantId: string, qty: number) => void
  clearCart: () => void
  placeOrder: () => Promise<QrPlaceOrderResponse | null>
  reset: () => void
}

/** Normalizes any thrown error into a code/message the UI can render. */
function readError(err: unknown): { code: string; message: string } {
  if (err instanceof ApiError) return { code: err.code, message: err.message }
  return { code: 'NETWORK', message: 'Tidak dapat terhubung. Coba lagi.' }
}

export const useQrStore = create<QrState>((set, get) => ({
  token: null,
  menu: null,
  cart: [],
  placed: null,
  loading: false,
  placing: false,
  errorCode: null,
  errorMessage: null,

  async loadMenu(token) {
    set({ loading: true, errorCode: null, errorMessage: null, token })
    try {
      const menu = await apiRequest<QrMenuResponse>(`/qr/${encodeURIComponent(token)}`)
      set({ menu, loading: false })
    } catch (err) {
      const { code, message } = readError(err)
      set({ loading: false, menu: null, errorCode: code, errorMessage: message })
    }
  },

  setQty(variantId, qty) {
    set((s) => ({ cart: setCartQty(s.cart, variantId, qty) }))
  },

  clearCart() {
    set({ cart: [] })
  },

  async placeOrder() {
    const { token, cart } = get()
    if (!token || cart.length === 0) return null
    set({ placing: true, errorCode: null, errorMessage: null })
    try {
      const result = await apiRequest<QrPlaceOrderResponse>(
        `/qr/${encodeURIComponent(token)}/orders`,
        { method: 'POST', body: { items: cart } }
      )
      // Keep the placed order; clear the cart so a back-nav can't double-submit.
      set({ placing: false, placed: result, cart: [] })
      return result
    } catch (err) {
      const { code, message } = readError(err)
      set({ placing: false, errorCode: code, errorMessage: message })
      return null
    }
  },

  reset() {
    set({
      token: null,
      menu: null,
      cart: [],
      placed: null,
      loading: false,
      placing: false,
      errorCode: null,
      errorMessage: null,
    })
  },
}))
