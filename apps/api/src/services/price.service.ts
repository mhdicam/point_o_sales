/**
 * Price service — S3-05, design §3.3.
 *
 * Price is not one number on a variant. A `PriceList` can be scoped to an outlet
 * and/or a sales method (dine-in vs takeaway vs online legitimately differ), and
 * `ProductVariant.basePrice` is the fallback when nothing matches.
 *
 * The resolution order is the part that must not drift, so it lives in exactly
 * one function (`resolve`) and every caller — POS, catalog, S4's bill pipeline —
 * goes through it. Reimplementing this comparison anywhere else is how two
 * screens start showing different prices for the same item.
 */

import type { BrewsyncClient, Prisma } from '@brewsync/db'
import { badRequest, notFound } from '../http-error.js'

interface CreatePriceListInput {
  name: string
  outletId?: string | null
  salesMethod?: string | null
  priority?: number
  validFrom?: Date | null
  validTo?: Date | null
}

type UpdatePriceListInput = Partial<CreatePriceListInput> & { isActive?: boolean }

/** The context a price is resolved *for*. */
export interface PriceContext {
  outletId?: string | null
  salesMethod?: string | null
  /** Defaults to now. Explicit so historical and scheduled prices are testable. */
  at?: Date
}

export interface ResolvedPrice {
  variantId: string
  price: bigint
  /** Which list won, or null when the variant's basePrice was used. */
  source: { kind: 'PRICE_LIST'; priceListId: string; priceListName: string } | { kind: 'BASE_PRICE' }
}

/**
 * Specificity of a matching list, high to low. A list naming both an outlet and a
 * sales method describes the context more precisely than one naming either alone,
 * so it wins regardless of `priority`.
 *
 * `priority` breaks ties *within* one specificity tier — that is what it is for
 * (two competing happy-hour lists for the same outlet), not for overriding how
 * well a list matches.
 */
function specificity(list: { outletId: string | null; salesMethod: string | null }): number {
  if (list.outletId !== null && list.salesMethod !== null) return 3
  if (list.outletId !== null) return 2
  if (list.salesMethod !== null) return 1
  return 0
}

export class PriceService {
  constructor(private readonly db: BrewsyncClient) {}

  /**
   * Resolves the effective price for one variant in one context.
   *
   * Order: most specific matching active in-window list (ties broken by
   * `priority` desc, then `createdAt` desc) → `variant.basePrice`.
   */
  async resolve(variantId: string, context: PriceContext = {}): Promise<ResolvedPrice> {
    const resolved = await this.resolveMany([variantId], context)
    const price = resolved.get(variantId)

    if (!price) {
      throw notFound('VARIANT_NOT_FOUND', `Variant ${variantId} not found`)
    }

    return price
  }

  /**
   * Batch form — one query set for many variants.
   *
   * The POS grid resolves every visible item at once; doing that one variant at a
   * time is N+1 round trips on the hottest read path in the app.
   */
  async resolveMany(
    variantIds: string[],
    context: PriceContext = {}
  ): Promise<Map<string, ResolvedPrice>> {
    const result = new Map<string, ResolvedPrice>()
    if (variantIds.length === 0) return result

    const at = context.at ?? new Date()

    const variants = await this.db.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, basePrice: true },
    })

    // Candidate lists: active, in the time window, and scoped either to this
    // context or globally (null = applies to everything).
    const candidates = await this.db.priceList.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: at } }] },
          { OR: [{ validTo: null }, { validTo: { gte: at } }] },
          { OR: [{ outletId: null }, ...(context.outletId ? [{ outletId: context.outletId }] : [])] },
          {
            OR: [
              { salesMethod: null },
              ...(context.salesMethod ? [{ salesMethod: context.salesMethod }] : []),
            ],
          },
        ],
      },
      select: {
        id: true,
        name: true,
        outletId: true,
        salesMethod: true,
        priority: true,
        createdAt: true,
        items: {
          where: { variantId: { in: variantIds } },
          select: { variantId: true, price: true },
        },
      },
    })

    // Most specific first, then priority, then newest — the one comparison that
    // defines "which price wins".
    const ordered = candidates.sort((a, b) => {
      const bySpecificity = specificity(b) - specificity(a)
      if (bySpecificity !== 0) return bySpecificity
      const byPriority = b.priority - a.priority
      if (byPriority !== 0) return byPriority
      return b.createdAt.getTime() - a.createdAt.getTime()
    })

    for (const variant of variants) {
      const winner = ordered.find((list) => list.items.some((i) => i.variantId === variant.id))

      if (winner) {
        const item = winner.items.find((i) => i.variantId === variant.id)!
        result.set(variant.id, {
          variantId: variant.id,
          price: item.price,
          source: { kind: 'PRICE_LIST', priceListId: winner.id, priceListName: winner.name },
        })
      } else {
        result.set(variant.id, {
          variantId: variant.id,
          price: variant.basePrice,
          source: { kind: 'BASE_PRICE' },
        })
      }
    }

    return result
  }

  /** ---- PriceList CRUD ---- */

  async createList(input: CreatePriceListInput) {
    this.assertWindow(input.validFrom ?? null, input.validTo ?? null)

    if (input.outletId) {
      await this.requireOutlet(input.outletId)
    }

    return await this.db.priceList.create({
      data: {
        name: input.name,
        outletId: input.outletId ?? null,
        salesMethod: input.salesMethod ?? null,
        priority: input.priority ?? 0,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
      } as unknown as Prisma.PriceListCreateInput,
    })
  }

  async updateList(priceListId: string, input: UpdatePriceListInput) {
    const existing = await this.requireList(priceListId)

    // Validate the resulting window, not just the changed field.
    this.assertWindow(
      input.validFrom !== undefined ? input.validFrom : existing.validFrom,
      input.validTo !== undefined ? input.validTo : existing.validTo
    )

    if (input.outletId !== undefined && input.outletId !== null) {
      await this.requireOutlet(input.outletId)
    }

    return await this.db.priceList.update({
      where: { id: priceListId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.outletId !== undefined && { outletId: input.outletId }),
        ...(input.salesMethod !== undefined && { salesMethod: input.salesMethod }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(input.validFrom !== undefined && { validFrom: input.validFrom }),
        ...(input.validTo !== undefined && { validTo: input.validTo }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      },
    })
  }

  /** Deletes a list. Items cascade — they have no meaning without their list. */
  async deleteList(priceListId: string): Promise<boolean> {
    const found = await this.db.priceList.findUnique({
      where: { id: priceListId },
      select: { id: true },
    })
    if (!found) return false

    await this.db.priceList.delete({ where: { id: priceListId } })
    return true
  }

  async listLists(opts: { outletId?: string; includeInactive?: boolean } = {}) {
    return await this.db.priceList.findMany({
      where: {
        ...(opts.outletId && { outletId: opts.outletId }),
        ...(opts.includeInactive ? {} : { isActive: true }),
      },
      include: { _count: { select: { items: true } } },
      orderBy: [{ priority: 'desc' }, { name: 'asc' }],
    })
  }

  async getListById(priceListId: string) {
    const list = await this.db.priceList.findUnique({
      where: { id: priceListId },
      include: {
        items: {
          include: {
            variant: { select: { id: true, sku: true, name: true, basePrice: true } },
          },
        },
      },
    })

    if (!list) {
      throw notFound('PRICE_LIST_NOT_FOUND', 'Price list not found')
    }

    return list
  }

  /** ---- PriceListItem operations ---- */

  /** Upsert by (priceListId, variantId) — setting a price twice is not an error. */
  async setItemPrice(priceListId: string, variantId: string, price: bigint) {
    await this.requireList(priceListId)
    await this.requireVariant(variantId)

    return await this.db.priceListItem.upsert({
      where: { priceListId_variantId: { priceListId, variantId } },
      update: { price },
      create: { priceListId, variantId, price } as unknown as Prisma.PriceListItemCreateInput,
    })
  }

  /**
   * Bulk set — the admin UI edits a whole list at once, and a partial write
   * would leave prices half-applied. One transaction, all or nothing.
   */
  async setItemPrices(priceListId: string, items: { variantId: string; price: bigint }[]) {
    await this.requireList(priceListId)

    if (items.length === 0) return { updated: 0 }

    const variantIds = items.map((i) => i.variantId)
    const found = await this.db.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true },
    })

    if (found.length !== new Set(variantIds).size) {
      const missing = variantIds.filter((id) => !found.some((v) => v.id === id))
      throw notFound('VARIANT_NOT_FOUND', `Variant(s) not found: ${missing.join(', ')}`)
    }

    await this.db.$transaction(
      items.map((item) =>
        this.db.priceListItem.upsert({
          where: { priceListId_variantId: { priceListId, variantId: item.variantId } },
          update: { price: item.price },
          create: {
            priceListId,
            variantId: item.variantId,
            price: item.price,
          } as unknown as Prisma.PriceListItemCreateInput,
        })
      )
    )

    return { updated: items.length }
  }

  async removeItem(priceListId: string, variantId: string): Promise<boolean> {
    const existing = await this.db.priceListItem.findUnique({
      where: { priceListId_variantId: { priceListId, variantId } },
      select: { id: true },
    })

    if (!existing) return false

    await this.db.priceListItem.delete({ where: { id: existing.id } })
    return true
  }

  /**
   * A validity window that closes before it opens matches nothing — it looks
   * configured but silently never applies, so reject it at write time.
   */
  private assertWindow(validFrom: Date | null, validTo: Date | null): void {
    if (validFrom && validTo && validTo < validFrom) {
      throw badRequest('INVALID_WINDOW', 'validTo cannot be earlier than validFrom')
    }
  }

  private async requireList(priceListId: string) {
    const list = await this.db.priceList.findUnique({
      where: { id: priceListId },
      select: { id: true, validFrom: true, validTo: true },
    })
    if (!list) {
      throw notFound('PRICE_LIST_NOT_FOUND', `Price list ${priceListId} not found`)
    }
    return list
  }

  private async requireVariant(variantId: string): Promise<void> {
    const found = await this.db.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true },
    })
    if (!found) {
      throw notFound('VARIANT_NOT_FOUND', `Variant ${variantId} not found`)
    }
  }

  private async requireOutlet(outletId: string): Promise<void> {
    const found = await this.db.outlet.findUnique({
      where: { id: outletId },
      select: { id: true },
    })
    if (!found) {
      throw notFound('OUTLET_NOT_FOUND', `Outlet ${outletId} not found`)
    }
  }
}
