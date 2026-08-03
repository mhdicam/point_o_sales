/**
 * Supplier service — S6-05, design §4.4.
 *
 * Tenant-owned CRUD for vendors. A supplier is master data shared across every
 * outlet (registered once, not per branch); PO lines reference it. `code` is the
 * fast-lookup handle and is unique per tenant — a collision surfaces as 409.
 * Per-item buy prices are NOT stored here; they live on PO lines because they
 * change every transaction (§4.4).
 *
 * Tenant scoping is the Prisma extension's job (standard #1): no
 * `where: { tenantId }` here. A supplier is deactivated, never hard-deleted — a
 * historical PO must keep resolving its vendor.
 */

import { type BrewsyncClient, type Prisma, requireTenantContext } from '@brewsync/db'
import { badRequest, conflict, notFound } from '../http-error.js'

export interface CreateSupplierInput {
  code: string
  name: string
  contactName?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
  /** NPWP — input-tax invoice. */
  taxId?: string | null
  /** 0 = cash, 30 = net-30. Drives the payable due date in Accounting. */
  paymentTermDays?: number
  defaultCurrency?: string
  isActive?: boolean
  notes?: string | null
}

/** `code` is frozen once created — PO history looks a supplier up by it. */
export type UpdateSupplierInput = Partial<Omit<CreateSupplierInput, 'code'>>

/** Prisma throws P2002 on the (tenantId, code) unique index. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  )
}

/** Trim to a non-empty string, or null. Keeps blank optional fields out of the DB. */
function orNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export class SupplierService {
  constructor(private readonly db: BrewsyncClient) {}

  async list(opts: { includeInactive?: boolean } = {}) {
    return await this.db.supplier.findMany({
      where: { ...(opts.includeInactive ? {} : { isActive: true }) },
      orderBy: [{ name: 'asc' }],
    })
  }

  async getById(id: string) {
    const supplier = await this.db.supplier.findUnique({ where: { id } })
    if (!supplier) throw notFound('SUPPLIER_NOT_FOUND', 'Supplier not found')
    return supplier
  }

  async create(input: CreateSupplierInput) {
    const ctx = requireTenantContext()
    const code = input.code.trim()
    if (code === '') throw badRequest('VALIDATION_ERROR', 'Supplier code is required')
    const name = input.name.trim()
    if (name === '') throw badRequest('VALIDATION_ERROR', 'Supplier name is required')
    const paymentTermDays = input.paymentTermDays ?? 0
    if (paymentTermDays < 0) {
      throw badRequest('VALIDATION_ERROR', 'Payment term days cannot be negative')
    }

    try {
      return await this.db.supplier.create({
        data: {
          tenantId: ctx.tenantId,
          code,
          name,
          contactName: orNull(input.contactName),
          phone: orNull(input.phone),
          email: orNull(input.email),
          address: orNull(input.address),
          taxId: orNull(input.taxId),
          paymentTermDays,
          defaultCurrency: input.defaultCurrency?.trim() || 'IDR',
          isActive: input.isActive ?? true,
          notes: orNull(input.notes),
          createdByUserId: ctx.userId ?? null,
        } as unknown as Prisma.SupplierCreateInput,
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('SUPPLIER_CODE_TAKEN', `Supplier code "${code}" is already in use`)
      }
      throw error
    }
  }

  async update(id: string, input: UpdateSupplierInput) {
    await this.getById(id)
    if (input.paymentTermDays !== undefined && input.paymentTermDays < 0) {
      throw badRequest('VALIDATION_ERROR', 'Payment term days cannot be negative')
    }
    return await this.db.supplier.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.contactName !== undefined && { contactName: orNull(input.contactName) }),
        ...(input.phone !== undefined && { phone: orNull(input.phone) }),
        ...(input.email !== undefined && { email: orNull(input.email) }),
        ...(input.address !== undefined && { address: orNull(input.address) }),
        ...(input.taxId !== undefined && { taxId: orNull(input.taxId) }),
        ...(input.paymentTermDays !== undefined && { paymentTermDays: input.paymentTermDays }),
        ...(input.defaultCurrency !== undefined && {
          defaultCurrency: input.defaultCurrency.trim() || 'IDR',
        }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.notes !== undefined && { notes: orNull(input.notes) }),
      },
    })
  }

  /**
   * Deactivates rather than deletes — a historical PO references this supplier
   * and its details must stay resolvable. A hard delete would orphan that record.
   */
  async deactivate(id: string) {
    await this.getById(id)
    return await this.db.supplier.update({
      where: { id },
      data: { isActive: false },
    })
  }
}
