/**
 * S7-04 — KDS routing policy unit tests.
 *
 * The pure decision behind SENT-time station routing: only a MADE_TO_ORDER line
 * in a KDS-enabled outlet is routed; the station is its category default, and an
 * unmapped category still queues (visible on the unrouted lane).
 */

import { describe, it, expect } from 'vitest'
import { routeLine } from '../../src/services/kds-routing.policy.js'

describe('S7-04 — KDS line routing', () => {
  it('routes a MADE_TO_ORDER line to its category station when KDS is on', () => {
    expect(routeLine(true, { fulfillmentType: 'MADE_TO_ORDER', defaultStationId: 'bar' })).toEqual({
      kdsStatus: 'QUEUED',
      stationId: 'bar',
    })
  })

  it('queues an unmapped MADE_TO_ORDER line with a null station (unrouted lane)', () => {
    expect(routeLine(true, { fulfillmentType: 'MADE_TO_ORDER', defaultStationId: null })).toEqual({
      kdsStatus: 'QUEUED',
      stationId: null,
    })
  })

  it('keeps a STOCKED line off the board even in a KDS outlet', () => {
    expect(routeLine(true, { fulfillmentType: 'STOCKED', defaultStationId: 'bar' })).toEqual({
      kdsStatus: null,
      stationId: null,
    })
  })

  it('keeps a SERVICE line off the board', () => {
    expect(routeLine(true, { fulfillmentType: 'SERVICE', defaultStationId: 'x' })).toEqual({
      kdsStatus: null,
      stationId: null,
    })
  })

  it('routes nothing when the outlet has KDS off, even for MADE_TO_ORDER', () => {
    expect(routeLine(false, { fulfillmentType: 'MADE_TO_ORDER', defaultStationId: 'bar' })).toEqual({
      kdsStatus: null,
      stationId: null,
    })
  })
})
