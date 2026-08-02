/**
 * Station service — S7-04, design §5.5.
 *
 * Tenant + outlet-scoped CRUD for KDS prep stations (kitchen, bar, dessert). A
 * category routes to a station via its `defaultStationId`; an item inherits that
 * routing at SENT (see order.service `send`). Outlets that leave `features.kds`
 * off never create stations, and nothing routes.
 *
 * Tenant scoping is the extension's job (standard #1); outletId is explicit
 * because stations are outlet-owned.
 */

import type { BrewsyncClient, Prisma } from '@brewsync/db'
import { badRequest, conflict, notFound } from '../http-error.js'

export interface CreateStationInput {
  outletId: string
  name: string
  sortOrder?: number
}

export interface UpdateStationInput {
  name?: string
  isActive?: boolean
  sortOrder?: number
}

export class StationService {
  constructor(private readonly db: BrewsyncClient) {}

  async list(outletId: string, opts: { includeInactive?: boolean } = {}) {
    return await this.db.station.findMany({
      where: {
        outletId,
        ...(opts.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
  }

  async getById(id: string) {
    const station = await this.db.station.findUnique({ where: { id } })
    if (!station) throw notFound('STATION_NOT_FOUND', 'Station not found')
    return station
  }

  async create(input: CreateStationInput) {
    await this.requireOutlet(input.outletId)

    const name = input.name.trim()
    if (name === '') throw badRequest('VALIDATION_ERROR', 'Station name is required')

    try {
      return await this.db.station.create({
        data: {
          outletId: input.outletId,
          name,
          sortOrder: input.sortOrder ?? 0,
        } as unknown as Prisma.StationCreateInput,
      })
    } catch (err) {
      throw this.rethrowNameConflict(err)
    }
  }

  async update(id: string, input: UpdateStationInput) {
    await this.getById(id)

    try {
      return await this.db.station.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name.trim() }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        },
      })
    } catch (err) {
      throw this.rethrowNameConflict(err)
    }
  }

  /** Deactivates rather than deletes — categories/items may still point here. */
  async deactivate(id: string) {
    await this.getById(id)
    return await this.db.station.update({
      where: { id },
      data: { isActive: false },
    })
  }

  private async requireOutlet(outletId: string): Promise<void> {
    const outlet = await this.db.outlet.findUnique({ where: { id: outletId }, select: { id: true } })
    if (!outlet) throw notFound('OUTLET_NOT_FOUND', `Outlet ${outletId} not found.`)
  }

  /** Maps a P2002 on the (outletId, name) unique index to a 409. */
  private rethrowNameConflict(err: unknown): never {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
      throw conflict('STATION_NAME_TAKEN', 'A station with that name already exists in this outlet.')
    }
    throw err
  }
}
