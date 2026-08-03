/**
 * Sales methods store — S7-01. A flat, display-ordered list of the tenant's
 * fulfillment methods (dine-in / takeaway / delivery), loaded once so the order
 * start picker can offer them. Config CRUD lives on the admin settings screen;
 * the cashier only reads the active set.
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type { SalesMethod } from '../lib/types.ts'

interface SalesMethodsState {
  items: SalesMethod[]
  loaded: boolean
  loading: boolean
  error: string | null

  list: () => Promise<void>
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

export const useSalesMethodsStore = create<SalesMethodsState>((set) => ({
  items: [],
  loaded: false,
  loading: false,
  error: null,

  list: async () => {
    set({ loading: true, error: null })
    try {
      const res = await apiRequest<{ salesMethods: SalesMethod[] }>('/sales-methods')
      set({ items: res.salesMethods, loaded: true, loading: false })
    } catch (err) {
      set({ error: message(err), loading: false })
    }
  },
}))
