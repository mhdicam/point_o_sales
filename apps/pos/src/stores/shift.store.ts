/**
 * Shift store — server state for the cash-drawer screen (S5-08).
 *
 * Wraps the shift API 1:1 (apps/api/src/routes/shift.routes.ts). Every response
 * carries the server-derived `drawerBalance` (SUM of the ledger) and, once
 * closed, the reconciliation figures; the store just holds the returned shift.
 * It never sums the ledger or derives a variance locally (standard #2/#3) — the
 * backend is the source of truth and the screen renders what it produced.
 *
 * Follows the Zustand pattern of orders.store.ts: `current` + `loading` + `busy`
 * + `error`; actions catch `ApiError` and expose its message.
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type { Shift } from '../lib/types.ts'

export interface OpenShiftPayload {
  outletId: string
  registerId?: string
  /** Opening float, minor units as a decimal string (standard #2). */
  openingFloatMinor: string
}

export interface MovementPayload {
  type: 'PAID_IN' | 'PAID_OUT' | 'DROP'
  amountMinor: string
  reason: string
}

export interface CloseShiftPayload {
  closingCountedCashMinor: string
  reason?: string
}

interface ShiftState {
  current: Shift | null
  /** True once a `current` fetch has resolved — distinguishes "no shift" from "unknown". */
  loaded: boolean
  loading: boolean
  busy: boolean
  error: string | null

  load: (outletId: string, registerId?: string) => Promise<void>
  open: (input: OpenShiftPayload) => Promise<void>
  addMovement: (shiftId: string, input: MovementPayload) => Promise<void>
  close: (shiftId: string, input: CloseShiftPayload) => Promise<void>
  clear: () => void
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

export const useShiftStore = create<ShiftState>((set) => ({
  current: null,
  loaded: false,
  loading: false,
  busy: false,
  error: null,

  load: async (outletId, registerId) => {
    set({ loading: true, error: null })
    try {
      const res = await apiRequest<{ shift: Shift | null }>('/shifts/current', {
        query: { outletId, ...(registerId ? { registerId } : {}) },
      })
      set({ current: res.shift, loaded: true, loading: false })
    } catch (err) {
      set({ error: message(err), loading: false })
    }
  },

  open: async (input) => {
    set({ busy: true, error: null })
    try {
      const res = await apiRequest<{ shift: Shift }>('/shifts', {
        method: 'POST',
        body: {
          outletId: input.outletId,
          openingFloatMinor: input.openingFloatMinor,
          ...(input.registerId ? { registerId: input.registerId } : {}),
        },
      })
      set({ current: res.shift, loaded: true, busy: false })
    } catch (err) {
      set({ error: message(err), busy: false })
    }
  },

  addMovement: async (shiftId, input) => {
    set({ busy: true, error: null })
    try {
      const res = await apiRequest<{ shift: Shift }>(`/shifts/${shiftId}/movements`, {
        method: 'POST',
        body: input,
      })
      set({ current: res.shift, busy: false })
    } catch (err) {
      set({ error: message(err), busy: false })
    }
  },

  close: async (shiftId, input) => {
    set({ busy: true, error: null })
    try {
      const res = await apiRequest<{ shift: Shift }>(`/shifts/${shiftId}/close`, {
        method: 'POST',
        body: {
          closingCountedCashMinor: input.closingCountedCashMinor,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      })
      set({ current: res.shift, busy: false })
    } catch (err) {
      set({ error: message(err), busy: false })
    }
  },

  clear: () => set({ current: null, loaded: false, error: null, busy: false, loading: false }),
}))
