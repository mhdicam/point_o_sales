/**
 * Sales method service — S7-01, design §6.
 *
 * Tenant-owned CRUD for how orders are fulfilled (dine-in / takeaway / delivery).
 * Orders reference a method by `code`, so `code` is immutable once set and unique
 * per tenant (the DB enforces the uniqueness; this service surfaces a collision
 * as a 409 and blocks the rename).
 *
 * The fiscal columns (taxRateBp / serviceChargeRateBp / taxInclusive) are stored
 * but NO-OP in S7 — `order.fiscal.ts` ignores them. They are accepted here so the
 * data model is complete when the per-method override is wired later.
 *
 * Tenant scoping is the Prisma extension's job (standard #1): no
 * `where: { tenantId }` here.
 */

import type { BrewsyncClient, Prisma, SalesMethodKind } from '@brewsync/db'
import { badRequest, conflict, notFound } from '../http-error.js'

export interface CreateSalesMethodInput {
  code: string
  name: string
  kind: SalesMethodKind
  /** Reserved fiscal override — stored but no-op in S7. */
  taxRateBp?: number | null
  serviceChargeRateBp?: number | null
  taxInclusive?: boolean | null
  isActive?: boolean
  sortOrder?: number
}

/** `code` and `kind` are frozen once created — orders join on `code`. */
export type UpdateSalesMethodInput = Partial<
  Omit<CreateSalesMethodInput, 'code' | 'kind'>
>

/** Prisma throws P2002 on the (tenantId, code) unique index. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  )
}

export class SalesMethodService {
  constructor(private readonly db: BrewsyncClient) {}

  async list(opts: { includeInactive?: boolean } = {}) {
    return await this.db.salesMethod.findMany({
      where: { ...(opts.includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    })
  }

  async getById(id: string) {
    const method = await this.db.salesMethod.findUnique({ where: { id } })
    if (!method) throw notFound('SALES_METHOD_NOT_FOUND', 'Sales method not found')
    return method
  }

  async create(input: CreateSalesMethodInput) {
    const code = input.code.trim()
    if (code === '') throw badRequest('VALIDATION_ERROR', 'Sales method code is required')

    try {
      return await this.db.salesMethod.create({
        data: {
          code,
          name: input.name.trim(),
          kind: input.kind,
          taxRateBp: input.taxRateBp ?? null,
          serviceChargeRateBp: input.serviceChargeRateBp ?? null,
          taxInclusive: input.taxInclusive ?? null,
          isActive: input.isActive ?? true,
          sortOrder: input.sortOrder ?? 0,
        } as unknown as Prisma.SalesMethodCreateInput,
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('SALES_METHOD_CODE_TAKEN', `Sales method code "${code}" is already in use`)
      }
      throw error
    }
  }

  async update(id: string, input: UpdateSalesMethodInput) {
    await this.getById(id)
    return await this.db.salesMethod.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.taxRateBp !== undefined && { taxRateBp: input.taxRateBp }),
        ...(input.serviceChargeRateBp !== undefined && {
          serviceChargeRateBp: input.serviceChargeRateBp,
        }),
        ...(input.taxInclusive !== undefined && { taxInclusive: input.taxInclusive }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      },
    })
  }

  /**
   * Deactivates rather than deletes — an order may reference this method by code
   * and its label must stay resolvable. A hard delete would orphan that history.
   */
  async deactivate(id: string) {
    await this.getById(id)
    return await this.db.salesMethod.update({
      where: { id },
      data: { isActive: false },
    })
  }
}
