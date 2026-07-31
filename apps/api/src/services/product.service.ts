/**
 * Product service — S3-03, design §3.3.
 *
 * The two hard invariants:
 * 1. Every product ≥ 1 variant (enforced at create; delete blocks on last variant).
 * 2. Exactly one isDefault variant per product (enforced at create/update).
 *
 * Products and variants are created atomically in one transaction. Updating the
 * default variant is a toggle: setting one clears the others.
 */

import type { BrewsyncClient, Prisma, FulfillmentType } from '@brewsync/db'
import { badRequest, notFound } from '../http-error.js'

interface CreateVariantInput {
  sku: string
  name: string
  barcode?: string | null
  basePrice?: bigint
  fulfillmentType?: FulfillmentType | null
  sellUnitId?: string | null
  stockUnitId?: string | null
  serviceDurationMin?: number | null
  isDefault?: boolean
  sortOrder?: number
}

interface CreateProductInput {
  categoryId?: string | null
  name: string
  slug: string
  description?: string | null
  imageUrl?: string | null
  fulfillmentType?: FulfillmentType
  sortOrder?: number
  variants: CreateVariantInput[]
}

type UpdateProductInput = Partial<
  Omit<CreateProductInput, 'variants'>
> & { isActive?: boolean }

interface UpdateVariantInput {
  sku?: string
  name?: string
  barcode?: string | null
  basePrice?: bigint
  fulfillmentType?: FulfillmentType | null
  sellUnitId?: string | null
  stockUnitId?: string | null
  serviceDurationMin?: number | null
  isDefault?: boolean
  isActive?: boolean
  sortOrder?: number
}

export class ProductService {
  constructor(private readonly db: BrewsyncClient) {}

  /**
   * Creates a product with at least one variant. Exactly one variant must be
   * marked `isDefault`; if none are, the first becomes default.
   */
  async create(input: CreateProductInput) {
    if (!input.variants || input.variants.length === 0) {
      throw badRequest('PRODUCT_NEEDS_VARIANT', 'A product must have at least one variant')
    }

    if (input.categoryId) {
      await this.requireCategoryExists(input.categoryId)
    }

    // Units referenced by variants must exist.
    const unitIds = new Set<string>()
    for (const v of input.variants) {
      if (v.sellUnitId) unitIds.add(v.sellUnitId)
      if (v.stockUnitId) unitIds.add(v.stockUnitId)
    }
    if (unitIds.size > 0) {
      await this.requireUnitsExist(Array.from(unitIds))
    }

    // Exactly one variant must be default. If none are marked, make the first default.
    const defaultCount = input.variants.filter((v) => v.isDefault === true).length
    if (defaultCount === 0) {
      input.variants[0]!.isDefault = true
    } else if (defaultCount > 1) {
      throw badRequest('MULTIPLE_DEFAULTS', 'Only one variant can be the default')
    }

    return await this.db.product.create({
      data: {
        name: input.name,
        slug: input.slug,
        categoryId: input.categoryId ?? null,
        description: input.description ?? null,
        imageUrl: input.imageUrl ?? null,
        fulfillmentType: input.fulfillmentType ?? 'STOCKED',
        sortOrder: input.sortOrder ?? 0,
        variants: {
          create: input.variants.map((v, idx) => ({
            sku: v.sku,
            name: v.name,
            barcode: v.barcode ?? null,
            basePrice: v.basePrice ?? 0n,
            fulfillmentType: v.fulfillmentType ?? null,
            sellUnitId: v.sellUnitId ?? null,
            stockUnitId: v.stockUnitId ?? null,
            serviceDurationMin: v.serviceDurationMin ?? null,
            isDefault: v.isDefault ?? false,
            sortOrder: v.sortOrder ?? idx,
          })),
        },
      } as unknown as Prisma.ProductCreateInput,
      include: { variants: true },
    })
  }

  async update(productId: string, input: UpdateProductInput) {
    await this.requireExists(productId)

    if (input.categoryId !== undefined && input.categoryId !== null) {
      await this.requireCategoryExists(input.categoryId)
    }

    return await this.db.product.update({
      where: { id: productId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.imageUrl !== undefined && { imageUrl: input.imageUrl }),
        ...(input.fulfillmentType !== undefined && { fulfillmentType: input.fulfillmentType }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      },
      include: { variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
    })
  }

  /**
   * Deletes a product. Cascades to variants (FK onDelete: Cascade).
   */
  async delete(productId: string): Promise<boolean> {
    const product = await this.db.product.findUnique({ where: { id: productId } })
    if (!product) return false

    await this.db.product.delete({ where: { id: productId } })
    return true
  }

  async list(opts: { categoryId?: string; includeInactive?: boolean } = {}) {
    return await this.db.product.findMany({
      where: {
        ...(opts.categoryId && { categoryId: opts.categoryId }),
        ...(opts.includeInactive ? {} : { isActive: true }),
      },
      include: {
        category: { select: { id: true, name: true } },
        _count: { select: { variants: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
  }

  async getById(productId: string) {
    const product = await this.db.product.findUnique({
      where: { id: productId },
      include: {
        category: true,
        variants: { orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }] },
      },
    })

    if (!product) {
      throw notFound('PRODUCT_NOT_FOUND', 'Product not found')
    }

    return product
  }

  /** ---- Variant operations ---- */

  /**
   * Creates a new variant under an existing product. If this variant is marked
   * `isDefault`, the old default is toggled off.
   */
  async createVariant(productId: string, input: CreateVariantInput) {
    await this.requireExists(productId)

    if (input.sellUnitId) await this.requireUnitExists(input.sellUnitId)
    if (input.stockUnitId) await this.requireUnitExists(input.stockUnitId)

    // If the new variant is default, clear the old default first.
    if (input.isDefault === true) {
      await this.db.productVariant.updateMany({
        where: { productId, isDefault: true },
        data: { isDefault: false },
      })
    }

    return await this.db.productVariant.create({
      data: {
        productId,
        sku: input.sku,
        name: input.name,
        barcode: input.barcode ?? null,
        basePrice: input.basePrice ?? 0n,
        fulfillmentType: input.fulfillmentType ?? null,
        sellUnitId: input.sellUnitId ?? null,
        stockUnitId: input.stockUnitId ?? null,
        serviceDurationMin: input.serviceDurationMin ?? null,
        isDefault: input.isDefault ?? false,
        sortOrder: input.sortOrder ?? 0,
      } as unknown as Prisma.ProductVariantCreateInput,
    })
  }

  async updateVariant(variantId: string, input: UpdateVariantInput) {
    const existing = await this.db.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true, productId: true },
    })
    if (!existing) {
      throw notFound('VARIANT_NOT_FOUND', 'Variant not found')
    }

    if (input.sellUnitId !== undefined && input.sellUnitId !== null) {
      await this.requireUnitExists(input.sellUnitId)
    }
    if (input.stockUnitId !== undefined && input.stockUnitId !== null) {
      await this.requireUnitExists(input.stockUnitId)
    }

    // If the caller sets isDefault = true, clear the old default. If they set
    // it = false but this *is* the current default, reject — a product must
    // always have one default.
    if (input.isDefault === true) {
      await this.db.productVariant.updateMany({
        where: { productId: existing.productId, isDefault: true, id: { not: variantId } },
        data: { isDefault: false },
      })
    } else if (input.isDefault === false) {
      const current = await this.db.productVariant.findUnique({
        where: { id: variantId },
        select: { isDefault: true },
      })
      if (current?.isDefault === true) {
        throw badRequest(
          'CANNOT_UNSET_DEFAULT',
          'Cannot unset the default variant without setting another one'
        )
      }
    }

    return await this.db.productVariant.update({
      where: { id: variantId },
      data: {
        ...(input.sku !== undefined && { sku: input.sku }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.barcode !== undefined && { barcode: input.barcode }),
        ...(input.basePrice !== undefined && { basePrice: input.basePrice }),
        ...(input.fulfillmentType !== undefined && { fulfillmentType: input.fulfillmentType }),
        ...(input.sellUnitId !== undefined && { sellUnitId: input.sellUnitId }),
        ...(input.stockUnitId !== undefined && { stockUnitId: input.stockUnitId }),
        ...(input.serviceDurationMin !== undefined && {
          serviceDurationMin: input.serviceDurationMin,
        }),
        ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      },
    })
  }

  /**
   * Deletes a variant. Refuses if it is the last variant of its product — the
   * product must have at least one.
   */
  async deleteVariant(variantId: string): Promise<boolean> {
    const variant = await this.db.productVariant.findUnique({
      where: { id: variantId },
      include: { product: { include: { _count: { select: { variants: true } } } } },
    })

    if (!variant) return false

    if (variant.product._count.variants === 1) {
      throw badRequest(
        'PRODUCT_NEEDS_VARIANT',
        'Cannot delete the last variant of a product. Delete the product instead.'
      )
    }

    await this.db.productVariant.delete({ where: { id: variantId } })
    return true
  }

  async listVariants(productId: string, opts: { includeInactive?: boolean } = {}) {
    await this.requireExists(productId)

    return await this.db.productVariant.findMany({
      where: {
        productId,
        ...(opts.includeInactive ? {} : { isActive: true }),
      },
      include: {
        sellUnit: { select: { id: true, code: true, name: true } },
        stockUnit: { select: { id: true, code: true, name: true } },
      },
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
    })
  }

  async getVariantById(variantId: string) {
    const variant = await this.db.productVariant.findUnique({
      where: { id: variantId },
      include: {
        product: { select: { id: true, name: true, slug: true } },
        sellUnit: true,
        stockUnit: true,
      },
    })

    if (!variant) {
      throw notFound('VARIANT_NOT_FOUND', 'Variant not found')
    }

    return variant
  }

  private async requireExists(productId: string): Promise<void> {
    const found = await this.db.product.findUnique({
      where: { id: productId },
      select: { id: true },
    })
    if (!found) {
      throw notFound('PRODUCT_NOT_FOUND', `Product ${productId} not found`)
    }
  }

  private async requireCategoryExists(categoryId: string): Promise<void> {
    const found = await this.db.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    })
    if (!found) {
      throw notFound('CATEGORY_NOT_FOUND', `Category ${categoryId} not found`)
    }
  }

  private async requireUnitExists(unitId: string): Promise<void> {
    const found = await this.db.unit.findUnique({
      where: { id: unitId },
      select: { id: true },
    })
    if (!found) {
      throw notFound('UNIT_NOT_FOUND', `Unit ${unitId} not found`)
    }
  }

  private async requireUnitsExist(unitIds: string[]): Promise<void> {
    const found = await this.db.unit.findMany({
      where: { id: { in: unitIds } },
      select: { id: true },
    })
    if (found.length !== unitIds.length) {
      const missing = unitIds.filter((id) => !found.some((u) => u.id === id))
      throw notFound('UNIT_NOT_FOUND', `Unit(s) not found: ${missing.join(', ')}`)
    }
  }
}
