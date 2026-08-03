/**
 * Floor-plan view helpers — S7-06. Pure, deterministic transforms over the
 * areas/tables the store loaded, so the screen stays declarative and the layout
 * logic is unit-testable without a DOM.
 *
 * Two jobs:
 *   - `groupFloor`: fold the flat area + table lists into the FLOOR → AREA →
 *     tables hierarchy the screen renders, each level sorted by `sortOrder` then
 *     name/code. Tables with no area (or an inactive/unknown area) collect under a
 *     synthetic "Unassigned" bucket so none are ever lost.
 *   - status visuals + `legalTableTransitions`: mirror the backend table state
 *     machine (table.state.ts) for UX only — the server still enforces every
 *     move (standard #5/#6). Kept in sync by hand; the backend is authoritative.
 */

import type { Area, Table, TableStatus } from './types.ts'

/** Tone tokens the UI maps to colors; kept abstract so the palette lives in one place. */
export type TableTone = 'empty' | 'occupied' | 'reserved' | 'dirty'

export interface TableStatusView {
  label: string
  tone: TableTone
}

const STATUS_VIEW: Record<TableStatus, TableStatusView> = {
  EMPTY: { label: 'Empty', tone: 'empty' },
  OCCUPIED: { label: 'Occupied', tone: 'occupied' },
  RESERVED: { label: 'Reserved', tone: 'reserved' },
  DIRTY: { label: 'Needs bussing', tone: 'dirty' },
}

export function tableStatusView(status: TableStatus): TableStatusView {
  return STATUS_VIEW[status]
}

/**
 * Legal next statuses for a manual floor action, mirroring tableStateMachine
 * (table.state.ts). UX only — surfacing exactly the moves the backend will
 * accept, so the cashier is never offered a status that 409s. OCCUPIED is
 * excluded everywhere: a table only becomes occupied by seating an order, never
 * by a manual status flip.
 */
const MANUAL_TRANSITIONS: Record<TableStatus, TableStatus[]> = {
  EMPTY: ['RESERVED', 'DIRTY'],
  OCCUPIED: ['DIRTY', 'EMPTY'],
  RESERVED: ['EMPTY'],
  DIRTY: ['EMPTY'],
}

export function legalTableTransitions(from: TableStatus): TableStatus[] {
  return MANUAL_TRANSITIONS[from]
}

/** One area (or the synthetic unassigned bucket) with its tables, sorted. */
export interface FloorGroup {
  areaId: string | null
  name: string
  kind: Area['kind'] | 'UNASSIGNED'
  tables: Table[]
}

const UNASSIGNED_ID = '__unassigned__'

function bySortThen<T extends { sortOrder: number }>(
  key: (t: T) => string
): (a: T, b: T) => number {
  return (a, b) => a.sortOrder - b.sortOrder || key(a).localeCompare(key(b))
}

/**
 * Fold flat areas + tables into an ordered list of groups. Active areas come
 * first (each in `sortOrder`/name order); any table whose `areaId` is null or
 * points at a missing/inactive area lands in a trailing "Unassigned" group. An
 * area with no tables still appears, so the admin can see it exists and add
 * tables to it.
 *
 * @param includeInactiveTables when false, inactive tables are dropped from each
 *   group (the cashier's live view); when true they are kept (the admin editor).
 */
export function groupFloor(
  areas: Area[],
  tables: Table[],
  options: { includeInactiveTables?: boolean } = {}
): FloorGroup[] {
  const includeInactive = options.includeInactiveTables ?? true

  const activeAreas = areas
    .filter((a) => a.isActive)
    .slice()
    .sort(bySortThen((a) => a.name))
  const knownAreaIds = new Set(activeAreas.map((a) => a.id))

  const visibleTables = tables.filter((t) => includeInactive || t.isActive)
  const sortTables = bySortThen<Table>((t) => t.code)

  const groups: FloorGroup[] = activeAreas.map((area) => ({
    areaId: area.id,
    name: area.name,
    kind: area.kind,
    tables: visibleTables
      .filter((t) => t.areaId === area.id)
      .slice()
      .sort(sortTables),
  }))

  const orphans = visibleTables
    .filter((t) => t.areaId === null || !knownAreaIds.has(t.areaId))
    .slice()
    .sort(sortTables)

  if (orphans.length > 0) {
    groups.push({
      areaId: UNASSIGNED_ID,
      name: 'Unassigned',
      kind: 'UNASSIGNED',
      tables: orphans,
    })
  }

  return groups
}

/** Live counts for the floor header (active tables only). */
export interface FloorSummary {
  total: number
  byStatus: Record<TableStatus, number>
}

export function floorSummary(tables: Table[]): FloorSummary {
  const byStatus: Record<TableStatus, number> = {
    EMPTY: 0,
    OCCUPIED: 0,
    RESERVED: 0,
    DIRTY: 0,
  }
  let total = 0
  for (const t of tables) {
    if (!t.isActive) continue
    total += 1
    byStatus[t.status] += 1
  }
  return { total, byStatus }
}
