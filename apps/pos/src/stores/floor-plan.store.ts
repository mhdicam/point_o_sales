/**
 * Floor-plan store — S7-06. Server state for the dine-in floor: areas, tables,
 * and KDS prep stations for the active outlet (design §5.4/§5.5).
 *
 * Wraps the floor-plan and station APIs 1:1 (apps/api/src/routes/floor-plan.routes.ts,
 * kds.routes.ts). Every mutation returns the changed row; the store refetches the
 * affected collection so ordering/derived fields always match the server rather
 * than being patched locally. Follows the Zustand-only pattern of the other
 * stores: per-collection `loaded`/`loading`, actions catch `ApiError`.
 *
 * Stations live here too (rather than a separate store) because the floor-plan
 * admin screen configures both surfaces; the cashier order screen never loads it.
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type { Area, AreaKind, Station, Table, TableStatus } from '../lib/types.ts'

export interface AreaInput {
  parentId?: string | null
  kind: AreaKind
  name: string
  sortOrder?: number
}

export interface TableInput {
  areaId?: string | null
  code: string
  name: string
  capacity?: number | null
  sortOrder?: number
}

export interface StationInput {
  name: string
  sortOrder?: number
}

interface FloorPlanState {
  outletId: string | null
  areas: Area[]
  tables: Table[]
  stations: Station[]
  loading: boolean
  loaded: boolean
  busy: boolean
  error: string | null

  /** Load all three collections for an outlet. Re-runnable on outlet switch. */
  load: (outletId: string) => Promise<void>

  createArea: (input: AreaInput) => Promise<void>
  updateArea: (id: string, input: Partial<AreaInput> & { isActive?: boolean }) => Promise<void>
  removeArea: (id: string) => Promise<void>

  createTable: (input: TableInput) => Promise<void>
  updateTable: (id: string, input: Partial<TableInput> & { isActive?: boolean }) => Promise<void>
  setTableStatus: (id: string, status: TableStatus) => Promise<void>
  removeTable: (id: string) => Promise<void>

  createStation: (input: StationInput) => Promise<void>
  updateStation: (id: string, input: Partial<StationInput> & { isActive?: boolean }) => Promise<void>
  removeStation: (id: string) => Promise<void>

  clear: () => void
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

export const useFloorPlanStore = create<FloorPlanState>((set, get) => ({
  outletId: null,
  areas: [],
  tables: [],
  stations: [],
  loading: false,
  loaded: false,
  busy: false,
  error: null,

  load: async (outletId) => {
    set({ loading: true, error: null, outletId })
    try {
      const [areasRes, tablesRes, stationsRes] = await Promise.all([
        apiRequest<{ areas: Area[] }>('/areas', {
          query: { outletId, includeInactive: 'true' },
        }),
        apiRequest<{ tables: Table[] }>('/tables', {
          query: { outletId, includeInactive: 'true' },
        }),
        apiRequest<{ stations: Station[] }>('/stations', {
          query: { outletId, includeInactive: 'true' },
        }),
      ])
      set({
        areas: areasRes.areas,
        tables: tablesRes.tables,
        stations: stationsRes.stations,
        loaded: true,
        loading: false,
      })
    } catch (err) {
      set({ error: message(err), loading: false })
    }
  },

  createArea: (input) =>
    withOutlet(set, get, async (outletId) => {
      await apiRequest<{ area: Area }>('/areas', { method: 'POST', body: { outletId, ...input } })
      await refetchAreas(set, outletId)
    }),

  updateArea: (id, input) =>
    withOutlet(set, get, async (outletId) => {
      await apiRequest<{ area: Area }>(`/areas/${id}`, { method: 'PUT', body: input })
      await refetchAreas(set, outletId)
    }),

  removeArea: (id) =>
    withOutlet(set, get, async (outletId) => {
      await apiRequest<{ area: Area }>(`/areas/${id}`, { method: 'DELETE' })
      await refetchAreas(set, outletId)
    }),

  createTable: (input) =>
    withOutlet(set, get, async (outletId) => {
      await apiRequest<{ table: Table }>('/tables', { method: 'POST', body: { outletId, ...input } })
      await refetchTables(set, outletId)
    }),

  updateTable: (id, input) =>
    withOutlet(set, get, async (outletId) => {
      await apiRequest<{ table: Table }>(`/tables/${id}`, { method: 'PUT', body: input })
      await refetchTables(set, outletId)
    }),

  setTableStatus: (id, status) =>
    withOutlet(set, get, async (outletId) => {
      await apiRequest<{ table: Table }>(`/tables/${id}/status`, {
        method: 'POST',
        body: { status },
      })
      await refetchTables(set, outletId)
    }),

  removeTable: (id) =>
    withOutlet(set, get, async (outletId) => {
      await apiRequest<{ table: Table }>(`/tables/${id}`, { method: 'DELETE' })
      await refetchTables(set, outletId)
    }),

  createStation: (input) =>
    withOutlet(set, get, async (outletId) => {
      await apiRequest<{ station: Station }>('/stations', {
        method: 'POST',
        body: { outletId, ...input },
      })
      await refetchStations(set, outletId)
    }),

  updateStation: (id, input) =>
    withOutlet(set, get, async (outletId) => {
      await apiRequest<{ station: Station }>(`/stations/${id}`, { method: 'PUT', body: input })
      await refetchStations(set, outletId)
    }),

  removeStation: (id) =>
    withOutlet(set, get, async (outletId) => {
      await apiRequest<{ station: Station }>(`/stations/${id}`, { method: 'DELETE' })
      await refetchStations(set, outletId)
    }),

  clear: () =>
    set({ outletId: null, areas: [], tables: [], stations: [], loaded: false, error: null }),
}))

/**
 * Shared mutation runner: needs a loaded outlet, flips `busy`, runs the body, and
 * translates failures to `error`. Keeps every action a one-liner and the
 * busy/error handling in one place (mirrors orders.store.ts `mutate`).
 */
async function withOutlet(
  set: (partial: Partial<FloorPlanState>) => void,
  get: () => FloorPlanState,
  body: (outletId: string) => Promise<void>
): Promise<void> {
  const outletId = get().outletId
  if (!outletId) {
    set({ error: 'No outlet selected.' })
    return
  }
  set({ busy: true, error: null })
  try {
    await body(outletId)
    set({ busy: false })
  } catch (err) {
    set({ error: message(err), busy: false })
    throw err
  }
}

async function refetchAreas(
  set: (partial: Partial<FloorPlanState>) => void,
  outletId: string
): Promise<void> {
  const res = await apiRequest<{ areas: Area[] }>('/areas', {
    query: { outletId, includeInactive: 'true' },
  })
  set({ areas: res.areas })
}

async function refetchTables(
  set: (partial: Partial<FloorPlanState>) => void,
  outletId: string
): Promise<void> {
  const res = await apiRequest<{ tables: Table[] }>('/tables', {
    query: { outletId, includeInactive: 'true' },
  })
  set({ tables: res.tables })
}

async function refetchStations(
  set: (partial: Partial<FloorPlanState>) => void,
  outletId: string
): Promise<void> {
  const res = await apiRequest<{ stations: Station[] }>('/stations', {
    query: { outletId, includeInactive: 'true' },
  })
  set({ stations: res.stations })
}
