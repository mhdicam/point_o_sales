import { describe, expect, it } from 'vitest'
import {
  buildLanes,
  bumpLabel,
  nextBump,
  ticketTone,
  UNROUTED_LANE,
} from './kds-view.ts'
import type { KdsBoard, KdsStatus, KdsTicket } from './types.ts'

function ticket(over: Partial<KdsTicket> = {}): KdsTicket {
  return {
    id: 't1',
    orderId: 'o1',
    stationId: 's1',
    kdsStatus: 'QUEUED',
    qty: 1,
    nameSnapshot: 'Latte',
    modifiersSnapshot: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    order: { channel: 'STAFF', tableId: null },
    ...over,
  }
}

function board(over: Partial<KdsBoard> = {}): KdsBoard {
  return {
    stations: [
      { id: 's1', name: 'Bar' },
      { id: 's2', name: 'Kitchen' },
    ],
    tickets: [],
    ...over,
  }
}

describe('buildLanes', () => {
  it('one lane per station, in station order', () => {
    const lanes = buildLanes(board())
    expect(lanes.map((l) => l.stationId)).toEqual(['s1', 's2'])
    expect(lanes.map((l) => l.name)).toEqual(['Bar', 'Kitchen'])
  })

  it('groups tickets under their station', () => {
    const lanes = buildLanes(
      board({
        tickets: [
          ticket({ id: 'a', stationId: 's2' }),
          ticket({ id: 'b', stationId: 's1' }),
        ],
      })
    )
    expect(lanes[0]?.tickets.map((t) => t.id)).toEqual(['b'])
    expect(lanes[1]?.tickets.map((t) => t.id)).toEqual(['a'])
  })

  it('sorts tickets oldest-first', () => {
    const lanes = buildLanes(
      board({
        tickets: [
          ticket({ id: 'new', createdAt: '2026-08-01T10:05:00.000Z' }),
          ticket({ id: 'old', createdAt: '2026-08-01T10:00:00.000Z' }),
        ],
      })
    )
    expect(lanes[0]?.tickets.map((t) => t.id)).toEqual(['old', 'new'])
  })

  it('collects station-less tickets into a trailing Unrouted lane', () => {
    const lanes = buildLanes(board({ tickets: [ticket({ id: 'x', stationId: null })] }))
    const last = lanes[lanes.length - 1]
    expect(last?.stationId).toBe(UNROUTED_LANE)
    expect(last?.name).toBe('Unrouted')
    expect(last?.tickets.map((t) => t.id)).toEqual(['x'])
  })

  it('routes a ticket at an unknown station to Unrouted', () => {
    const lanes = buildLanes(board({ tickets: [ticket({ id: 'x', stationId: 'gone' })] }))
    expect(lanes[lanes.length - 1]?.stationId).toBe(UNROUTED_LANE)
  })

  it('keeps an empty lane for a station with no tickets', () => {
    const lanes = buildLanes(board())
    expect(lanes.every((l) => l.tickets.length === 0)).toBe(true)
    expect(lanes).toHaveLength(2)
  })

  it('adds no Unrouted lane when every ticket is routed', () => {
    const lanes = buildLanes(board({ tickets: [ticket({ stationId: 's1' })] }))
    expect(lanes.some((l) => l.stationId === UNROUTED_LANE)).toBe(false)
  })
})

describe('nextBump', () => {
  it('follows the happy path', () => {
    expect(nextBump('QUEUED')).toBe('PREPARING')
    expect(nextBump('PREPARING')).toBe('READY')
    expect(nextBump('READY')).toBe('SERVED')
  })

  it('has no forward move from terminal statuses', () => {
    for (const s of ['SERVED', 'VOID'] as KdsStatus[]) {
      expect(nextBump(s)).toBeNull()
    }
  })
})

describe('bumpLabel', () => {
  it('labels each forward action', () => {
    expect(bumpLabel('QUEUED')).toBe('Start')
    expect(bumpLabel('PREPARING')).toBe('Ready')
    expect(bumpLabel('READY')).toBe('Serve')
  })
})

describe('ticketTone', () => {
  it('maps status to a tone', () => {
    expect(ticketTone('QUEUED')).toBe('queued')
    expect(ticketTone('PREPARING')).toBe('preparing')
    expect(ticketTone('READY')).toBe('ready')
  })
})
