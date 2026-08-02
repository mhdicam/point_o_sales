/**
 * Area service — S7-02, design §5.4.
 *
 * Tenant + outlet-scoped CRUD for the floor-plan hierarchy above tables. A FLOOR
 * is a top-level area (no parent); an AREA nests under a floor (or another area).
 * Retail and service leave `features.tables` off and never create these.
 *
 * Tenant scoping is the extension's job (standard #1); outletId is explicit
 * because areas are outlet-owned.
 */

import type { BrewsyncClient, Prisma, AreaKind } from '@brewsync/db'
import { badRequest, notFound } from '../http-error.js'

export interface CreateAreaInput {
  outletId: string
  parentId?: string | null
  kind: AreaKind
  name: string
  sortOrder?: number
}

export interface UpdateAreaInput {
  parentId?: string | null
  name?: string
  isActive?: boolean
  sortOrder?: number
}

export class AreaService {
  constructor(private readonly db: BrewsyncClient) {}

  async list(outletId: string, opts: { includeInactive?: boolean } = {}) {
    return await this.db.area.findMany({
      where: {
        outletId,
        ...(opts.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
  }

  async getById(id: string) {
    const area = await this.db.area.findUnique({ where: { id } })
    if (!area) throw notFound('AREA_NOT_FOUND', 'Area not found')
    return area
  }

  async create(input: CreateAreaInput) {
    await this.requireOutlet(input.outletId)
    if (input.parentId) await this.getById(input.parentId)

    const name = input.name.trim()
    if (name === '') throw badRequest('VALIDATION_ERROR', 'Area name is required')

    return await this.db.area.create({
      data: {
        outletId: input.outletId,
        parentId: input.parentId ?? null,
        kind: input.kind,
        name,
        sortOrder: input.sortOrder ?? 0,
      } as unknown as Prisma.AreaCreateInput,
    })
  }

  async update(id: string, input: UpdateAreaInput) {
    await this.getById(id)
    if (input.parentId !== undefined && input.parentId !== null) {
      if (input.parentId === id) {
        throw badRequest('VALIDATION_ERROR', 'An area cannot be its own parent')
      }
      await this.getById(input.parentId)
    }

    return await this.db.area.update({
      where: { id },
      data: {
        ...(input.parentId !== undefined && { parentId: input.parentId }),
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      },
    })
  }

  /** Deactivates rather than deletes — tables may still point at this area. */
  async deactivate(id: string) {
    await this.getById(id)
    return await this.db.area.update({
      where: { id },
      data: { isActive: false },
    })
  }

  private async requireOutlet(outletId: string): Promise<void> {
    const outlet = await this.db.outlet.findUnique({ where: { id: outletId }, select: { id: true } })
    if (!outlet) throw notFound('OUTLET_NOT_FOUND', `Outlet ${outletId} not found.`)
  }
}
