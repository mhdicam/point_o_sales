/**
 * Price lists store — S3-05. A price list holds per-variant overrides; the list
 * metadata is edited here, and items are set in bulk via PUT .../items.
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type { PriceList } from '../lib/types.ts'

export interface PriceListInput {
  name: string
  outletId?: string | null
  salesMethod?: string | null
  priority?: number
  validFrom?: string | null
  validTo?: string | null
  isActive?: boolean
}

export interface PriceItemInput {
  variantId: string
  /** Minor units, string. */
  price: string
}

interface PricesState {
  lists: PriceList[]
  loading: boolean
  error: string | null

  list: (opts?: { includeInactive?: boolean }) => Promise<void>
  create: (input: PriceListInput) => Promise<PriceList>
  update: (id: string, input: Partial<PriceListInput>) => Promise<PriceList>
  remove: (id: string) => Promise<void>
  setItems: (listId: string, items: PriceItemInput[]) => Promise<void>
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

export const usePricesStore = create<PricesState>((set, get) => ({
  lists: [],
  loading: false,
  error: null,

  list: async (opts = {}) => {
    set({ loading: true, error: null })
    try {
      const res = await apiRequest<{ lists: PriceList[] }>('/prices/lists', {
        query: { includeInactive: opts.includeInactive ?? null },
      })
      set({ lists: res.lists, loading: false })
    } catch (err) {
      set({ error: message(err), loading: false })
    }
  },

  create: async (input) => {
    const res = await apiRequest<{ list: PriceList }>('/prices/lists', {
      method: 'POST',
      body: input,
    })
    await get().list({ includeInactive: true })
    return res.list
  },

  update: async (id, input) => {
    const res = await apiRequest<{ list: PriceList }>(`/prices/lists/${id}`, {
      method: 'PUT',
      body: input,
    })
    await get().list({ includeInactive: true })
    return res.list
  },

  remove: async (id) => {
    await apiRequest<{ deleted: boolean }>(`/prices/lists/${id}`, { method: 'DELETE' })
    await get().list({ includeInactive: true })
  },

  setItems: async (listId, items) => {
    await apiRequest(`/prices/lists/${listId}/items`, { method: 'PUT', body: { items } })
  },
}))
