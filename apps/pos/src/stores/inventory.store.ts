/**
 * Inventory store — S6-09. Server state for stock levels at the active outlet:
 * the outlet valuation summary (on-hand + value per variant), a single-variant
 * ledger (the inventory card), and the stock-opname adjustment action.
 *
 * Wraps the stock API 1:1 (apps/api/src/routes/stock.routes.ts). Reads are gated
 * on `inventory.view`, the adjustment on `inventory.adjust` — the backend is the
 * security boundary (standard #5); this store is UX plumbing. On-hand and value
 * are always server-derived from the append-only ledger (standard #3): the store
 * refetches after an adjustment rather than patching a balance locally.
 *
 * Quantities cross the wire as scaled decimal strings; the screen builds the
 * scaled `qtyScaled` for an adjustment via UNIT_FACTOR_SCALE.
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type { OnHand, OutletValuation, StockMovement } from '../lib/types.ts'

/** Manual movement types a stock-opname / correction can create. */
export type ManualStockMovementType = 'ADJUSTMENT' | 'WASTE' | 'TRANSFER' | 'PRODUCTION'

export interface AdjustInput {
  variantId: string
  /** Signed quantity in the variant's stock unit, scaled by UNIT_FACTOR_SCALE. */
  qtyScaled: bigint
  type: ManualStockMovementType
  /** Cost per one base unit, minor units. Optional — a pure count omits it. */
  costPerUnit?: bigint | null
  reason?: string | null
}

interface InventoryState {
  outletId: string | null
  valuation: OutletValuation | null
  /** The variant whose ledger is currently open, and its rows. */
  cardVariantId: string | null
  card: StockMovement[]
  loading: boolean
  loaded: boolean
  busy: boolean
  error: string | null

  /** Load the outlet valuation summary. Re-runnable on outlet switch. */
  load: (outletId: string) => Promise<void>
  /** Open the inventory card (ledger) for one variant. */
  openCard: (variantId: string) => Promise<void>
  closeCard: () => void
  /** Post a stock-opname / manual correction, then refetch the summary. */
  adjust: (input: AdjustInput) => Promise<OnHand>
  clear: () => void
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

export const useInventoryStore = create<InventoryState>((set, get) => ({
  outletId: null,
  valuation: null,
  cardVariantId: null,
  card: [],
  loading: false,
  loaded: false,
  busy: false,
  error: null,

  load: async (outletId) => {
    set({ loading: true, error: null, outletId })
    try {
      const res = await apiRequest<{ valuation: OutletValuation }>('/stock/valuation', {
        query: { outletId },
      })
      set({ valuation: res.valuation, loaded: true, loading: false })
    } catch (err) {
      set({ error: message(err), loading: false })
    }
  },

  openCard: async (variantId) => {
    const outletId = get().outletId
    if (!outletId) {
      set({ error: 'No outlet selected.' })
      return
    }
    set({ cardVariantId: variantId, card: [], error: null })
    try {
      const res = await apiRequest<{ movements: StockMovement[] }>('/stock/history', {
        query: { outletId, variantId },
      })
      set({ card: res.movements })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  closeCard: () => set({ cardVariantId: null, card: [] }),

  adjust: async (input) => {
    const outletId = get().outletId
    if (!outletId) throw new Error('No outlet selected.')
    set({ busy: true, error: null })
    try {
      const res = await apiRequest<{ onHand: OnHand }>('/stock/adjust', {
        method: 'POST',
        body: {
          outletId,
          variantId: input.variantId,
          qtyScaled: input.qtyScaled.toString(),
          type: input.type,
          ...(input.costPerUnit != null ? { costPerUnit: input.costPerUnit.toString() } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
        },
      })
      await get().load(outletId)
      set({ busy: false })
      return res.onHand
    } catch (err) {
      set({ error: message(err), busy: false })
      throw err
    }
  },

  clear: () =>
    set({
      outletId: null,
      valuation: null,
      cardVariantId: null,
      card: [],
      loaded: false,
      error: null,
    }),
}))
