/**
 * Units store — units of measure. `factor` crosses the wire as a scaled decimal
 * string (BigInt × 1e6); the form edits it as a plain decimal string and the
 * backend parses it, so the store passes it through untouched.
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type { Unit, UnitDimension } from '../lib/types.ts'

export interface UnitInput {
  code: string
  name: string
  dimension: UnitDimension
  baseUnitId?: string | null
  /** Decimal string, e.g. "1000" for a kg built on g. */
  factor?: string
  isActive?: boolean
}

interface UnitsState {
  items: Unit[]
  loading: boolean
  error: string | null

  list: (opts?: { includeInactive?: boolean }) => Promise<void>
  create: (input: UnitInput) => Promise<Unit>
  update: (id: string, input: Partial<UnitInput>) => Promise<Unit>
  remove: (id: string) => Promise<void>
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

export const useUnitsStore = create<UnitsState>((set, get) => ({
  items: [],
  loading: false,
  error: null,

  list: async (opts = {}) => {
    set({ loading: true, error: null })
    try {
      const res = await apiRequest<{ units: Unit[] }>('/units', {
        query: { includeInactive: opts.includeInactive ?? null },
      })
      set({ items: res.units, loading: false })
    } catch (err) {
      set({ error: message(err), loading: false })
    }
  },

  create: async (input) => {
    const res = await apiRequest<{ unit: Unit }>('/units', { method: 'POST', body: input })
    await get().list({ includeInactive: true })
    return res.unit
  },

  update: async (id, input) => {
    const res = await apiRequest<{ unit: Unit }>(`/units/${id}`, { method: 'PUT', body: input })
    await get().list({ includeInactive: true })
    return res.unit
  },

  remove: async (id) => {
    await apiRequest<{ deleted: boolean }>(`/units/${id}`, { method: 'DELETE' })
    await get().list({ includeInactive: true })
  },
}))
