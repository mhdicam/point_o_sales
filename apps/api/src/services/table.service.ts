/**
 * Table service — S7-02, design §5.4.
 *
 * Tenant + outlet-scoped CRUD for physical tables. A table lives in an area
 * (nullable, for uncategorized tables) and cycles through occupancy states
 * (empty → occupied/reserved → dirty → empty). The state machine (table.state.ts)
 * enforces legal transitions; an illegal move throws → 409.
 *
 * `qrToken` is a random base64url token for QR self-service ordering (§16.2),
 * globally unique across all tenants. It is generated once at creation and never
 * changed (a QR printed on the table stays valid).
 *
 * Tenant scoping is the extension's job (standard #1); outletId is explicit in
 * every filter because tables are outlet-owned (the same code "T1" may exist at
 * multiple outlets).
 */

import { randomBytes } from 'node:crypto'
import type { BrewsyncClient, Prisma, TableStatus } from '@brewsync/db'
import { badRequest, conflict, notFound } from '../http-error.js'
import { tableStateMachine } from './table.state.js'

export interface CreateTableInput {
  outletId: string
  areaId?: string | null
  code: string
  name: string
  capacity?: number | null
  sortOrder?: number
}

export interface UpdateTableInput {
  areaId?: string | null
  name?: string
  capacity?: number | null
  isActive?: boolean
  sortOrder?: number
}

/** Prisma throws P2002 on the (outletId, code) unique index. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  )
}

/** Generate a globally unique QR token for self-service ordering (§16.2). */
function newQrToken(): string {
  return randomBytes(24).toString('base64url')
}

export class TableService {
  constructor(private readonly db: BrewsyncClient) {}

  async list(outletId: string, opts: { includeInactive?: boolean; areaId?: string | null } = {}) {
    return await this.db.table.findMany({
      where: {
        outletId,
        ...(opts.areaId !== undefined ? { areaId: opts.areaId } : {}),
        ...(opts.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    })
  }

  async getById(id: string) {
    const table = await this.db.table.findUnique({ where: { id } })
    if (!table) throw notFound('TABLE_NOT_FOUND', 'Table not found')
    return table
  }

  async create(input: CreateTableInput) {
    await this.requireOutlet(input.outletId)
    if (input.areaId) await this.requireArea(input.areaId)

    const code = input.code.trim()
    if (code === '') throw badRequest('VALIDATION_ERROR', 'Table code is required')

    try {
      return await this.db.table.create({
        data: {
          outletId: input.outletId,
          areaId: input.areaId ?? null,
          code,
          name: input.name.trim(),
          status: tableStateMachine.initial,
          capacity: input.capacity ?? null,
          qrToken: newQrToken(),
          sortOrder: input.sortOrder ?? 0,
        } as unknown as Prisma.TableCreateInput,
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('TABLE_CODE_TAKEN', `Table code "${code}" is already in use at this outlet`)
      }
      throw error
    }
  }

  async update(id: string, input: UpdateTableInput) {
    await this.getById(id)
    if (input.areaId !== undefined && input.areaId !== null) {
      await this.requireArea(input.areaId)
    }

    return await this.db.table.update({
      where: { id },
      data: {
        ...(input.areaId !== undefined && { areaId: input.areaId }),
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.capacity !== undefined && { capacity: input.capacity }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      },
    })
  }

  /**
   * Transitions the table to a new status (design §5.4). The state machine
   * (table.state.ts) enforces legal moves; an illegal transition throws
   * IllegalTransitionError → 409.
   */
  async setStatus(id: string, newStatus: TableStatus) {
    const table = await this.getById(id)
    tableStateMachine.assert(table.status, newStatus)

    return await this.db.table.update({
      where: { id },
      data: { status: newStatus },
    })
  }

  /**
   * Rotates the QR token (§16.2). Called when a physical QR is replaced or a
   * token leaks: the old URL stops resolving the moment the new token is stored,
   * so any QR printed with the previous token is dead. Globally unique, so a
   * P2002 (astronomically unlikely on 24 random bytes) retries once.
   */
  async rotateQrToken(id: string) {
    await this.getById(id)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.db.table.update({
          where: { id },
          data: { qrToken: newQrToken() },
        })
      } catch (error) {
        if (isUniqueViolation(error) && attempt === 0) continue
        throw error
      }
    }
    throw conflict('QR_TOKEN_COLLISION', 'Could not allocate a unique QR token; try again.')
  }

  /**
   * Deactivates rather than deletes — an order may reference this table and its
   * label must stay resolvable. A hard delete would orphan that history.
   */
  async deactivate(id: string) {
    await this.getById(id)
    return await this.db.table.update({
      where: { id },
      data: { isActive: false },
    })
  }

  private async requireOutlet(outletId: string): Promise<void> {
    const outlet = await this.db.outlet.findUnique({ where: { id: outletId }, select: { id: true } })
    if (!outlet) throw notFound('OUTLET_NOT_FOUND', `Outlet ${outletId} not found.`)
  }

  private async requireArea(areaId: string): Promise<void> {
    const area = await this.db.area.findUnique({ where: { id: areaId }, select: { id: true } })
    if (!area) throw notFound('AREA_NOT_FOUND', `Area ${areaId} not found.`)
  }
}
