import { describe, expect, it } from 'vitest'
import {
  floorSummary,
  groupFloor,
  legalTableTransitions,
  tableStatusView,
} from './floor-plan-view.ts'
import type { Area, Table } from './types.ts'

function area(over: Partial<Area> = {}): Area {
  return {
    id: 'a1',
    outletId: 'out1',
    parentId: null,
    kind: 'AREA',
    name: 'Indoor',
    sortOrder: 0,
    isActive: true,
    ...over,
  }
}

function table(over: Partial<Table> = {}): Table {
  return {
    id: 't1',
    outletId: 'out1',
    areaId: 'a1',
    code: 'T1',
    name: 'Table 1',
    status: 'EMPTY',
    capacity: 4,
    qrToken: 'tok',
    sortOrder: 0,
    isActive: true,
    ...over,
  }
}

describe('groupFloor', () => {
  it('groups tables under their area', () => {
    const groups = groupFloor([area()], [table()])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.areaId).toBe('a1')
    expect(groups[0]?.tables.map((t) => t.id)).toEqual(['t1'])
  })

  it('sorts areas by sortOrder then name, tables by sortOrder then code', () => {
    const areas = [
      area({ id: 'b', name: 'Bar', sortOrder: 1 }),
      area({ id: 'a', name: 'Indoor', sortOrder: 0 }),
    ]
    const tables = [
      table({ id: 't2', areaId: 'a', code: 'T2', sortOrder: 1 }),
      table({ id: 't1', areaId: 'a', code: 'T1', sortOrder: 0 }),
      table({ id: 't3', areaId: 'b', code: 'B1', sortOrder: 0 }),
    ]
    const groups = groupFloor(areas, tables)
    expect(groups.map((g) => g.areaId)).toEqual(['a', 'b'])
    expect(groups[0]?.tables.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('keeps an area with no tables', () => {
    const groups = groupFloor([area()], [])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.tables).toEqual([])
  })

  it('collects null-area tables into a trailing Unassigned group', () => {
    const tables = [table({ id: 't0', areaId: null, code: 'X1' }), table()]
    const groups = groupFloor([area()], tables)
    expect(groups).toHaveLength(2)
    expect(groups[1]?.name).toBe('Unassigned')
    expect(groups[1]?.kind).toBe('UNASSIGNED')
    expect(groups[1]?.tables.map((t) => t.id)).toEqual(['t0'])
  })

  it('treats a table pointing at an inactive/unknown area as unassigned', () => {
    const groups = groupFloor(
      [area({ isActive: false })],
      [table({ areaId: 'a1' })]
    )
    // The area is inactive so it is not rendered; its table falls to Unassigned.
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('Unassigned')
  })

  it('drops inactive tables when includeInactiveTables is false', () => {
    const tables = [table({ id: 't1' }), table({ id: 't2', code: 'T2', isActive: false })]
    const live = groupFloor([area()], tables, { includeInactiveTables: false })
    expect(live[0]?.tables.map((t) => t.id)).toEqual(['t1'])
    const admin = groupFloor([area()], tables, { includeInactiveTables: true })
    expect(admin[0]?.tables.map((t) => t.id)).toEqual(['t1', 't2'])
  })
})

describe('floorSummary', () => {
  it('counts active tables by status', () => {
    const tables = [
      table({ id: 't1', status: 'EMPTY' }),
      table({ id: 't2', status: 'OCCUPIED' }),
      table({ id: 't3', status: 'OCCUPIED' }),
      table({ id: 't4', status: 'DIRTY', isActive: false }),
    ]
    const summary = floorSummary(tables)
    expect(summary.total).toBe(3)
    expect(summary.byStatus.EMPTY).toBe(1)
    expect(summary.byStatus.OCCUPIED).toBe(2)
    expect(summary.byStatus.DIRTY).toBe(0)
  })
})

describe('legalTableTransitions', () => {
  it('never offers OCCUPIED as a manual move', () => {
    for (const from of ['EMPTY', 'OCCUPIED', 'RESERVED', 'DIRTY'] as const) {
      expect(legalTableTransitions(from)).not.toContain('OCCUPIED')
    }
  })

  it('mirrors the backend machine for each state', () => {
    expect(legalTableTransitions('EMPTY')).toEqual(['RESERVED', 'DIRTY'])
    expect(legalTableTransitions('OCCUPIED')).toEqual(['DIRTY', 'EMPTY'])
    expect(legalTableTransitions('RESERVED')).toEqual(['EMPTY'])
    expect(legalTableTransitions('DIRTY')).toEqual(['EMPTY'])
  })
})

describe('tableStatusView', () => {
  it('maps each status to a label and tone', () => {
    expect(tableStatusView('EMPTY')).toEqual({ label: 'Empty', tone: 'empty' })
    expect(tableStatusView('DIRTY').tone).toBe('dirty')
  })
})
