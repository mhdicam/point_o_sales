/**
 * Category service — S3-01, design §3.1.
 *
 * Categories nest via self-reference. Two things need care:
 *
 * 1. **Cycle prevention.** Re-parenting a category under its own descendant
 *    would create an orphaned ring — invisible from the root, and any recursive
 *    walk over it never terminates. Checked before every parent change.
 * 2. **Default inheritance.** A category carries defaults (tax rate, KDS station,
 *    report group) that flow down. Resolution walks up to the nearest ancestor
 *    that sets the field; the outlet setting is the final fallback. That
 *    precedence lives here so it cannot drift between callers.
 */

import type { BrewsyncClient, Prisma } from '@brewsync/db'
import { badRequest, notFound } from '../http-error.js'

interface CreateCategoryInput {
  name: string
  slug: string
  parentId?: string | null
  sortOrder?: number
  defaultTaxRateBp?: number | null
  defaultStationId?: string | null
  reportGroup?: string | null
}

type UpdateCategoryInput = Partial<CreateCategoryInput> & { isActive?: boolean }

/** Defaults a category contributes, after walking its ancestors. */
export interface ResolvedCategoryDefaults {
  defaultTaxRateBp: number | null
  defaultStationId: string | null
  reportGroup: string | null
  /** The category each value came from — useful for showing "inherited from X" in the UI. */
  inheritedFrom: {
    defaultTaxRateBp: string | null
    defaultStationId: string | null
    reportGroup: string | null
  }
}

export class CategoryService {
  constructor(private readonly db: BrewsyncClient) {}

  async create(input: CreateCategoryInput) {
    if (input.parentId) {
      await this.requireExists(input.parentId)
    }

    return await this.db.category.create({
      // tenantId omitted deliberately — the Prisma extension injects it
      // (standard #1). The cast is the seam between the generated type and what
      // the extension supplies.
      data: {
        name: input.name,
        slug: input.slug,
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder ?? 0,
        defaultTaxRateBp: input.defaultTaxRateBp ?? null,
        defaultStationId: input.defaultStationId ?? null,
        reportGroup: input.reportGroup ?? null,
      } as unknown as Prisma.CategoryCreateInput,
    })
  }

  async update(categoryId: string, input: UpdateCategoryInput) {
    await this.requireExists(categoryId)

    // Re-parenting is the only operation that can corrupt the tree shape.
    if (input.parentId !== undefined && input.parentId !== null) {
      if (input.parentId === categoryId) {
        throw badRequest('CATEGORY_CYCLE', 'A category cannot be its own parent')
      }
      await this.requireExists(input.parentId)
      await this.assertNotDescendant(categoryId, input.parentId)
    }

    return await this.db.category.update({
      where: { id: categoryId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.parentId !== undefined && { parentId: input.parentId }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.defaultTaxRateBp !== undefined && { defaultTaxRateBp: input.defaultTaxRateBp }),
        ...(input.defaultStationId !== undefined && { defaultStationId: input.defaultStationId }),
        ...(input.reportGroup !== undefined && { reportGroup: input.reportGroup }),
      },
    })
  }

  /**
   * Deletes a category. Refuses while it still has children or products —
   * `onDelete: Restrict` on the self-relation would raise a raw FK error, so this
   * turns it into an explanatory 400 instead.
   */
  async delete(categoryId: string): Promise<boolean> {
    const category = await this.db.category.findUnique({
      where: { id: categoryId },
      include: { _count: { select: { children: true, products: true } } },
    })

    if (!category) return false

    if (category._count.children > 0) {
      throw badRequest(
        'CATEGORY_HAS_CHILDREN',
        `Category still has ${category._count.children} subcategory(ies). Move or delete them first.`
      )
    }

    if (category._count.products > 0) {
      throw badRequest(
        'CATEGORY_HAS_PRODUCTS',
        `Category still has ${category._count.products} product(s). Reassign them first.`
      )
    }

    await this.db.category.delete({ where: { id: categoryId } })
    return true
  }

  /** Flat list, ordered for display. The caller builds the tree if it needs one. */
  async list(opts: { includeInactive?: boolean } = {}) {
    return await this.db.category.findMany({
      where: opts.includeInactive ? {} : { isActive: true },
      include: { _count: { select: { children: true, products: true } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
  }

  async getById(categoryId: string) {
    const category = await this.db.category.findUnique({
      where: { id: categoryId },
      include: {
        parent: true,
        children: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
        _count: { select: { products: true } },
      },
    })

    if (!category) {
      throw notFound('CATEGORY_NOT_FOUND', 'Category not found')
    }

    return category
  }

  /**
   * Resolves inherited defaults by walking up the ancestor chain — design §3.1
   * ("set once on the category, inherited by everything beneath").
   *
   * The nearest ancestor that sets a field wins. Each field resolves
   * independently: a category may inherit its tax rate from its grandparent
   * while setting its own station.
   */
  async resolveDefaults(categoryId: string): Promise<ResolvedCategoryDefaults> {
    const resolved: ResolvedCategoryDefaults = {
      defaultTaxRateBp: null,
      defaultStationId: null,
      reportGroup: null,
      inheritedFrom: { defaultTaxRateBp: null, defaultStationId: null, reportGroup: null },
    }

    // The cycle guard on update() should make an unbounded chain impossible, but
    // a `seen` set means a corrupted row cannot hang the request thread either.
    const seen = new Set<string>()
    let currentId: string | null = categoryId

    while (currentId && !seen.has(currentId)) {
      seen.add(currentId)

      const node: {
        parentId: string | null
        defaultTaxRateBp: number | null
        defaultStationId: string | null
        reportGroup: string | null
      } | null = await this.db.category.findUnique({
        where: { id: currentId },
        select: {
          parentId: true,
          defaultTaxRateBp: true,
          defaultStationId: true,
          reportGroup: true,
        },
      })

      if (!node) break

      if (resolved.defaultTaxRateBp === null && node.defaultTaxRateBp !== null) {
        resolved.defaultTaxRateBp = node.defaultTaxRateBp
        resolved.inheritedFrom.defaultTaxRateBp = currentId
      }
      if (resolved.defaultStationId === null && node.defaultStationId !== null) {
        resolved.defaultStationId = node.defaultStationId
        resolved.inheritedFrom.defaultStationId = currentId
      }
      if (resolved.reportGroup === null && node.reportGroup !== null) {
        resolved.reportGroup = node.reportGroup
        resolved.inheritedFrom.reportGroup = currentId
      }

      currentId = node.parentId
    }

    return resolved
  }

  private async requireExists(categoryId: string): Promise<void> {
    const found = await this.db.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    })
    if (!found) {
      throw notFound('CATEGORY_NOT_FOUND', `Category ${categoryId} not found`)
    }
  }

  /**
   * Rejects re-parenting a category under one of its own descendants.
   *
   * Walks up from the *proposed parent*: if we meet `categoryId` on the way to
   * the root, the proposed parent sits beneath it and the move would close a ring.
   */
  private async assertNotDescendant(categoryId: string, proposedParentId: string): Promise<void> {
    const seen = new Set<string>()
    let cursor: string | null = proposedParentId

    while (cursor) {
      if (cursor === categoryId) {
        throw badRequest(
          'CATEGORY_CYCLE',
          'Cannot move a category under one of its own descendants'
        )
      }
      if (seen.has(cursor)) break
      seen.add(cursor)

      const node: { parentId: string | null } | null = await this.db.category.findUnique({
        where: { id: cursor },
        select: { parentId: true },
      })
      cursor = node?.parentId ?? null
    }
  }
}
