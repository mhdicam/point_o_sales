/**
 * Categories store — flat, display-ordered list plus CRUD. The tree is built in
 * the view with buildCategoryTree (lib/category-tree.ts); the store stays flat to
 * mirror the API and to keep refetch-after-mutate simple.
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type { Category } from '../lib/types.ts'

export interface CategoryInput {
  name: string
  slug: string
  parentId?: string | null
  sortOrder?: number
  isActive?: boolean
  defaultTaxRateBp?: number | null
  defaultStationId?: string | null
  reportGroup?: string | null
}

interface CategoriesState {
  items: Category[]
  loading: boolean
  error: string | null

  list: (opts?: { includeInactive?: boolean }) => Promise<void>
  create: (input: CategoryInput) => Promise<Category>
  update: (id: string, input: Partial<CategoryInput>) => Promise<Category>
  remove: (id: string) => Promise<void>
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

export const useCategoriesStore = create<CategoriesState>((set, get) => ({
  items: [],
  loading: false,
  error: null,

  list: async (opts = {}) => {
    set({ loading: true, error: null })
    try {
      const res = await apiRequest<{ categories: Category[] }>('/categories', {
        query: { includeInactive: opts.includeInactive ?? null },
      })
      set({ items: res.categories, loading: false })
    } catch (err) {
      set({ error: message(err), loading: false })
    }
  },

  create: async (input) => {
    const res = await apiRequest<{ category: Category }>('/categories', {
      method: 'POST',
      body: input,
    })
    await get().list({ includeInactive: true })
    return res.category
  },

  update: async (id, input) => {
    const res = await apiRequest<{ category: Category }>(`/categories/${id}`, {
      method: 'PUT',
      body: input,
    })
    await get().list({ includeInactive: true })
    return res.category
  },

  remove: async (id) => {
    await apiRequest<{ deleted: boolean }>(`/categories/${id}`, { method: 'DELETE' })
    await get().list({ includeInactive: true })
  },
}))
