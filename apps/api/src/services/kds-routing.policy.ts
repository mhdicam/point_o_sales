/**
 * KDS routing policy — S7-04, design §5.5.
 *
 * The pure, DB-free decision of *whether* an order line enters the kitchen
 * display and *which* station it lands at, computed once at SENT. Kept apart from
 * `OrderService` so the rule can be unit-tested without a database.
 *
 * Two data points drive it, never a vertical name (the "one core" rule): the
 * outlet's `features.kds` toggle and the line's effective `fulfillmentType`. Only
 * a `MADE_TO_ORDER` line in a KDS-enabled outlet is routed; everything else stays
 * off the board (`kdsStatus` null). The station is the line's category station
 * *already resolved for the order's outlet* (`defaultStationId`) — Category is
 * tenant-scoped while Station is outlet-owned, so the caller resolves the
 * category's station-name hint to a concrete station in this outlet before calling
 * in. An unmapped category (or a hint with no same-named station in this outlet)
 * still queues the item — it appears on an "unrouted" lane rather than vanishing —
 * so a missing mapping is visible, not silent.
 */

import type { FulfillmentType } from '@brewsync/db'

/** What the router needs to know about one line's master data at SENT. */
export interface RoutingLine {
  /** The line's effective fulfillment type (variant override ?? product default). */
  fulfillmentType: FulfillmentType
  /** The station resolved for this outlet from the category hint, or null when unmapped. */
  defaultStationId: string | null
}

/** The routing decision for one line. */
export interface RoutingDecision {
  /** QUEUED when the line enters the KDS, else null (never shown on the board). */
  kdsStatus: 'QUEUED' | null
  /** The resolved station, or null (KDS-off, non-MTO, or unmapped category). */
  stationId: string | null
}

/**
 * Decides a line's KDS routing at SENT. `kdsEnabled` is the outlet's `features.kds`
 * toggle, read once by the caller.
 */
export function routeLine(kdsEnabled: boolean, line: RoutingLine): RoutingDecision {
  if (!kdsEnabled || line.fulfillmentType !== 'MADE_TO_ORDER') {
    return { kdsStatus: null, stationId: null }
  }
  // MADE_TO_ORDER in a KDS outlet always queues; the station may still be null
  // (category unmapped) — that item lands on the unrouted lane.
  return { kdsStatus: 'QUEUED', stationId: line.defaultStationId }
}
