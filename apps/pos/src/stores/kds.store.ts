/**
 * KDS store — S7-07. Server state for the kitchen board (design §5.5).
 *
 * Two data sources, one truth:
 *   - REST GET /kds/board is the initial paint and the authoritative projection.
 *   - a WebSocket to /ws/kds pushes an OrderSent / KdsItemUpdated frame whenever a
 *     ticket is routed or a lane advances (≤2s, outbox-sourced — S7-05).
 *
 * On any push the store *refetches* the board rather than patching it from the
 * frame's payload. The board is a derived projection (which lines are still
 * active, grouped by station); refetching keeps the client rendering exactly what
 * the server computed instead of reconstructing it (same spirit as standard #2/#3
 * — the FE renders, it does not recompute). Frames are deliberately treated as a
 * "something changed, re-read" signal, not as deltas to apply.
 *
 * The socket is owned here (connect/disconnect are actions) so the board screen
 * stays a pure view; a dropped socket surfaces as `live=false` and the screen can
 * fall back to its initial data until it reconnects.
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import { openKdsSocket, type KdsSocketHandle } from '../lib/kds-socket.ts'
import type { KdsBoard } from '../lib/types.ts'

interface KdsState {
  outletId: string | null
  board: KdsBoard | null
  loading: boolean
  error: string | null
  /** True while the realtime socket is connected. */
  live: boolean

  /** Load the board and open the realtime socket for an outlet. */
  connect: (outletId: string) => Promise<void>
  /** Re-read the board (called on a realtime frame, or manually). */
  refresh: () => Promise<void>
  /** Close the socket and drop state (screen unmount / outlet switch). */
  disconnect: () => void
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

let socket: KdsSocketHandle | null = null

export const useKdsStore = create<KdsState>((set, get) => ({
  outletId: null,
  board: null,
  loading: false,
  error: null,
  live: false,

  connect: async (outletId) => {
    get().disconnect()
    set({ outletId, loading: true, error: null, board: null })
    await fetchBoard(set, outletId)

    socket = openKdsSocket(outletId, {
      onFrame: () => {
        // A frame means "the board changed" — re-read rather than patch.
        void get().refresh()
      },
      onOpen: () => set({ live: true }),
      onClose: () => set({ live: false }),
    })
  },

  refresh: async () => {
    const outletId = get().outletId
    if (!outletId) return
    await fetchBoard(set, outletId)
  },

  disconnect: () => {
    if (socket) {
      socket.close()
      socket = null
    }
    set({ live: false })
  },
}))

async function fetchBoard(
  set: (partial: Partial<KdsState>) => void,
  outletId: string
): Promise<void> {
  try {
    const board = await apiRequest<KdsBoard>('/kds/board', { query: { outletId } })
    set({ board, loading: false })
  } catch (err) {
    set({ error: message(err), loading: false })
  }
}
