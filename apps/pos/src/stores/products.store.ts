/**
 * Products store — server state for the admin product list + editor.
 *
 * Follows the Zustand-only decision (no TanStack Query): the store owns the
 * fetched list, a loading/error flag, and the mutation actions. Screens read
 * `items` and call actions; the store refetches the list after a successful
 * mutation so the virtualized list stays truthful without hand-patching.
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type {
  CreateProductPayload,
  UpdateProductPayload,
} from '../lib/product-form.ts'
import type { Product, ProductListItem } from '../lib/types.ts'

interface ProductsState {
  items: ProductListItem[]
  loading: boolean
  error: string | null

  list: (opts?: { categoryId?: string; includeInactive?: boolean }) => Promise<void>
  getById: (id: string) => Promise<Product>
  create: (payload: CreateProductPayload) => Promise<Product>
  update: (id: string, payload: UpdateProductPayload) => Promise<Product>
  remove: (id: string) => Promise<void>
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

export const useProductsStore = create<ProductsState>((set, get) => ({
  items: [],
  loading: false,
  error: null,

  list: async (opts = {}) => {
    set({ loading: true, error: null })
    try {
      const res = await apiRequest<{ products: ProductListItem[] }>('/products', {
        query: {
          categoryId: opts.categoryId ?? null,
          includeInactive: opts.includeInactive ?? null,
        },
      })
      set({ items: res.products, loading: false })
    } catch (err) {
      set({ error: message(err), loading: false })
    }
  },

  getById: async (id) => {
    const res = await apiRequest<{ product: Product }>(`/products/${id}`)
    return res.product
  },

  create: async (payload) => {
    const res = await apiRequest<{ product: Product }>('/products', {
      method: 'POST',
      body: payload,
    })
    await get().list()
    return res.product
  },

  update: async (id, payload) => {
    const res = await apiRequest<{ product: Product }>(`/products/${id}`, {
      method: 'PUT',
      body: payload,
    })
    await get().list()
    return res.product
  },

  remove: async (id) => {
    await apiRequest<{ deleted: boolean }>(`/products/${id}`, { method: 'DELETE' })
    await get().list()
  },
}))
