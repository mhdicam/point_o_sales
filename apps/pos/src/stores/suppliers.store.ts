/**
 * Suppliers store — vendor master (S6-05). Feature-gated: the routes sit behind
 * features.purchasing and permission supplier.manage, so the screen hides behind
 * useFeature('purchasing') too (standard #5 — UX side of the guard).
 *
 * `code` is set at create and frozen; a delete deactivates rather than removes so
 * historical POs keep resolving their vendor.
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type { Supplier } from '../lib/types.ts'

export interface SupplierInput {
  code: string
  name: string
  contactName?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
  taxId?: string | null
  paymentTermDays?: number
  defaultCurrency?: string
  isActive?: boolean
  notes?: string | null
}

/** `code` is frozen once created — PO history looks a supplier up by it. */
export type SupplierUpdate = Partial<Omit<SupplierInput, 'code'>>

interface SuppliersState {
  suppliers: Supplier[]
  loading: boolean
  error: string | null

  list: (opts?: { includeInactive?: boolean }) => Promise<void>
  create: (input: SupplierInput) => Promise<Supplier>
  update: (id: string, input: SupplierUpdate) => Promise<Supplier>
  deactivate: (id: string) => Promise<void>
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

export const useSuppliersStore = create<SuppliersState>((set, get) => ({
  suppliers: [],
  loading: false,
  error: null,

  list: async (opts = {}) => {
    set({ loading: true, error: null })
    try {
      const res = await apiRequest<{ suppliers: Supplier[] }>('/suppliers', {
        query: { includeInactive: opts.includeInactive ?? null },
      })
      set({ suppliers: res.suppliers, loading: false })
    } catch (err) {
      set({ error: message(err), loading: false })
    }
  },

  create: async (input) => {
    const res = await apiRequest<{ supplier: Supplier }>('/suppliers', {
      method: 'POST',
      body: input,
    })
    await get().list({ includeInactive: true })
    return res.supplier
  },

  update: async (id, input) => {
    const res = await apiRequest<{ supplier: Supplier }>(`/suppliers/${id}`, {
      method: 'PUT',
      body: input,
    })
    await get().list({ includeInactive: true })
    return res.supplier
  },

  deactivate: async (id) => {
    await apiRequest<{ supplier: Supplier }>(`/suppliers/${id}`, { method: 'DELETE' })
    await get().list({ includeInactive: true })
  },
}))
