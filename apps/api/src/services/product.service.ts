/**
 * Product service — S3-03, design §3.3.
 *
 * The three hard invariants:
 * 1. Every product ≥ 1 variant (enforced at create; delete blocks on last variant).
 * 2. Exactly one isDefault variant per product (enforced at create/update).
 * 3. At most one isCover image per product (enforced at add/update; the first
 *    image added becomes the cover, and removing the cover promotes the next).
 *
 * All three live here rather than in the database. A partial unique index would
 * express (2) and (3) more tightly, but Prisma cannot model one, so `migrate dev`
 * would report it forever as schema drift.
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
  fulfillmentType?: FulfillmentType
  sortOrder?: number
  variants: CreateVariantInput[]
  images?: CreateImageInput[]
}

interface CreateImageInput {
  url: string
  alt?: string | null
  isCover?: boolean
  sortOrder?: number
}

interface UpdateImageInput {
  url?: string
  alt?: string | null
  isCover?: boolean
  sortOrder?: number
}

type UpdateProductInput = Partial<
  Omit<CreateProductInput, 'variants' | 'images'>
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

/**
 * Cover first, then explicit sortOrder, then insertion time. The last key is not
 * cosmetic: two rows sharing a sortOrder would otherwise come back in whatever
 * order Postgres finds convenient, so the gallery would shuffle between requests.
 */
const IMAGE_ORDER = [
  { isCover: 'desc' as const },
  { sortOrder: 'asc' as const },
  { createdAt: 'asc' as const },
]

/**
 * Same normalization the variants get for `isDefault`: if the caller marked no
 * cover, the first image wins; two covers is a caller bug, not something to
 * resolve silently.
 */
function normalizeCoverOnCreate(images: CreateImageInput[]): CreateImageInput[] {
  if (images.length === 0) return images

  const coverCount = images.filter((i) => i.isCover === true).length
  if (coverCount === 0) {
    images[0]!.isCover = true
  } else if (coverCount > 1) {
    throw badRequest('MULTIPLE_COVERS', 'Only one image can be the cover')
  }

  return images
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

    const images = normalizeCoverOnCreate(input.images ?? [])

    return await this.db.product.create({
      data: {
        name: input.name,
        slug: input.slug,
        categoryId: input.categoryId ?? null,
        description: input.description ?? null,
        fulfillmentType: input.fulfillmentType ?? 'STOCKED',
        sortOrder: input.sortOrder ?? 0,
        ...(images.length > 0 && {
          images: {
            create: images.map((img, idx) => ({
              url: img.url,
              alt: img.alt ?? null,
              isCover: img.isCover ?? false,
              sortOrder: img.sortOrder ?? idx,
            })),
          },
        }),
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
      include: { variants: true, images: { orderBy: IMAGE_ORDER } },
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
        ...(input.fulfillmentType !== undefined && { fulfillmentType: input.fulfillmentType }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      },
      include: {
        variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
        images: { orderBy: IMAGE_ORDER },
      },
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
        // Cover only: a product grid needs one thumbnail per card, and shipping
        // the whole gallery for every row is the classic list-endpoint bloat.
        images: { where: { isCover: true }, take: 1 },
        _count: { select: { variants: true, images: true } },
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
        images: { orderBy: IMAGE_ORDER },
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

  /** ---- Image operations ---- */

  async listImages(productId: string) {
    await this.requireExists(productId)

    return await this.db.productImage.findMany({
      where: { productId },
      orderBy: IMAGE_ORDER,
    })
  }

  /**
   * Appends an image. The first image of a product is always its cover — a
   * product with images but no cover would leave every grid card blank.
   */
  async addImage(productId: string, input: CreateImageInput) {
    await this.requireExists(productId)

    const existingCount = await this.db.productImage.count({ where: { productId } })
    const isCover = existingCount === 0 ? true : (input.isCover ?? false)

    if (isCover && existingCount > 0) {
      await this.clearCover(productId)
    }

    // Default sortOrder appends rather than colliding on 0.
    let sortOrder = input.sortOrder
    if (sortOrder === undefined) {
      const last = await this.db.productImage.findFirst({
        where: { productId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      })
      sortOrder = last ? last.sortOrder + 1 : 0
    }

    return await this.db.productImage.create({
      data: {
        productId,
        url: input.url,
        alt: input.alt ?? null,
        isCover,
        sortOrder,
      } as unknown as Prisma.ProductImageCreateInput,
    })
  }

  async updateImage(imageId: string, input: UpdateImageInput) {
    const existing = await this.db.productImage.findUnique({
      where: { id: imageId },
      select: { id: true, productId: true, isCover: true },
    })
    if (!existing) {
      throw notFound('IMAGE_NOT_FOUND', 'Image not found')
    }

    // Same toggle shape as the default variant: promoting one demotes the rest,
    // and demoting the only cover is refused rather than silently leaving none.
    if (input.isCover === true) {
      await this.clearCover(existing.productId, imageId)
    } else if (input.isCover === false && existing.isCover) {
      throw badRequest(
        'CANNOT_UNSET_COVER',
        'Cannot unset the cover image without setting another one'
      )
    }

    return await this.db.productImage.update({
      where: { id: imageId },
      data: {
        ...(input.url !== undefined && { url: input.url }),
        ...(input.alt !== undefined && { alt: input.alt }),
        ...(input.isCover !== undefined && { isCover: input.isCover }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      },
    })
  }

  /**
   * Deletes an image. Unlike a variant this has no minimum — a product may have
   * none. Deleting the cover promotes the next image in display order, so the
   * invariant "images exist ⇒ exactly one is cover" survives.
   */
  async deleteImage(imageId: string): Promise<boolean> {
    const image = await this.db.productImage.findUnique({
      where: { id: imageId },
      select: { id: true, productId: true, isCover: true },
    })
    if (!image) return false

    await this.db.productImage.delete({ where: { id: imageId } })

    if (image.isCover) {
      const next = await this.db.productImage.findFirst({
        where: { productId: image.productId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      })
      if (next) {
        await this.db.productImage.update({
          where: { id: next.id },
          data: { isCover: true },
        })
      }
    }

    return true
  }

  /**
   * Rewrites display order from a full list of ids. Requires the complete set:
   * a partial list would silently interleave the omitted images at whatever
   * sortOrder they happened to hold.
   */
  async reorderImages(productId: string, imageIds: string[]) {
    await this.requireExists(productId)

    const current = await this.db.productImage.findMany({
      where: { productId },
      select: { id: true },
    })

    const currentIds = new Set(current.map((i) => i.id))
    const givenIds = new Set(imageIds)

    if (givenIds.size !== imageIds.length) {
      throw badRequest('DUPLICATE_IMAGE_ID', 'Image ids must be unique')
    }
    if (givenIds.size !== currentIds.size || imageIds.some((id) => !currentIds.has(id))) {
      throw badRequest(
        'INCOMPLETE_IMAGE_ORDER',
        'Reorder must list every image of the product exactly once'
      )
    }

    for (const [idx, id] of imageIds.entries()) {
      await this.db.productImage.update({ where: { id }, data: { sortOrder: idx } })
    }

    return await this.db.productImage.findMany({
      where: { productId },
      orderBy: IMAGE_ORDER,
    })
  }

  /** Demotes the current cover, optionally excluding the row about to become it. */
  private async clearCover(productId: string, exceptId?: string): Promise<void> {
    await this.db.productImage.updateMany({
      where: {
        productId,
        isCover: true,
        ...(exceptId && { id: { not: exceptId } }),
      },
      data: { isCover: false },
    })
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
