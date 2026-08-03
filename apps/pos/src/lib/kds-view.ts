/**
 * KDS board view helpers — S7-07, design §5.5.
 *
 * Pure transforms over the board projection the API returns (GET /kds/board),
 * so the board screen stays declarative and the lane/bump logic is unit-testable
 * without a DOM or a socket.
 *
 *   - `buildLanes`: fold the flat ticket list into one column per active station,
 *     plus a trailing "Unrouted" column for station-less made-to-order lines
 *     (§5.5 — never dropped). Tickets sort oldest-first so the kitchen works FIFO.
 *   - `nextBump` / `bumpLabel`: the single forward action per lane, mirroring the
 *     backend KDS state machine (kds.state.ts) for UX only — the server still
 *     validates every move (standard #5/#6).
 */

import type { KdsBoard, KdsStatus, KdsTicket } from './types.ts'

/** The synthetic column id for station-less (unrouted) tickets. */
export const UNROUTED_LANE = '__unrouted__'

export interface KdsLane {
  stationId: string
  name: string
  tickets: KdsTicket[]
}

/**
 * One column per active station (in the board's station order), each holding its
 * QUEUED/PREPARING/READY tickets oldest-first. Station-less tickets collect in a
 * trailing "Unrouted" lane so an unmapped made-to-order line is visible rather
 * than lost. A station with no tickets still shows — an empty lane is a valid,
 * informative state on a kitchen screen.
 */
export function buildLanes(board: KdsBoard): KdsLane[] {
  const byStation = new Map<string, KdsTicket[]>()
  for (const station of board.stations) byStation.set(station.id, [])
  const unrouted: KdsTicket[] = []

  for (const ticket of board.tickets) {
    if (ticket.stationId && byStation.has(ticket.stationId)) {
      byStation.get(ticket.stationId)!.push(ticket)
    } else {
      unrouted.push(ticket)
    }
  }

  const byAge = (a: KdsTicket, b: KdsTicket): number =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

  const lanes: KdsLane[] = board.stations.map((station) => ({
    stationId: station.id,
    name: station.name,
    tickets: (byStation.get(station.id) ?? []).slice().sort(byAge),
  }))

  if (unrouted.length > 0) {
    lanes.push({
      stationId: UNROUTED_LANE,
      name: 'Unrouted',
      tickets: unrouted.slice().sort(byAge),
    })
  }

  return lanes
}

/**
 * The forward bump for a lane status, mirroring kdsStateMachine's happy path
 * (QUEUED → PREPARING → READY → SERVED). Returns null for a status with no
 * forward move on the board. Bumping-back and voiding are separate deliberate
 * actions, not the primary tap.
 */
export function nextBump(from: KdsStatus): KdsStatus | null {
  switch (from) {
    case 'QUEUED':
      return 'PREPARING'
    case 'PREPARING':
      return 'READY'
    case 'READY':
      return 'SERVED'
    default:
      return null
  }
}

/** Verb on the bump button for a ticket's current status. */
export function bumpLabel(from: KdsStatus): string {
  switch (from) {
    case 'QUEUED':
      return 'Start'
    case 'PREPARING':
      return 'Ready'
    case 'READY':
      return 'Serve'
    default:
      return ''
  }
}

/** Tone token for a ticket's status (kitchen screens map it to a color). */
export type KdsTone = 'queued' | 'preparing' | 'ready'

export function ticketTone(status: KdsStatus): KdsTone {
  return status === 'READY' ? 'ready' : status === 'PREPARING' ? 'preparing' : 'queued'
}
