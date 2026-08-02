/**
 * Recipe service — S6-03, design §3.4 (gated by `features.recipe`).
 *
 * Owns a variant's recipe: the CRUD the recipe editor drives, and the graph
 * loader the sale path (S6-02) explodes to base ingredients. A recipe is 1:1
 * with the ProductVariant it produces; its items are edited as a whole set
 * (replace-all) so the editor never has to diff line-by-line.
 *
 * The explosion math itself is pure and lives in @brewsync/shared
 * (`explodeRecipe`, `perUnitQty`); this service only assembles the graph from
 * the DB — normalising each component quantity from its recipe unit into the
 * component's own scaled base units, and dividing batch recipes down to a
 * per-finished-unit basis — and hands it over. Cycle detection is the pure
 * helper's job.
 *
 * Tenant scoping is the extension's job (standard #1): no `where: { tenantId }`
 * here. Writes run in `withTenantTransaction`.
 */

import {
  type BrewsyncClient,
  type Prisma,
  type PrismaClient,
  withTenantTransaction,
  requireTenantContext,
} from '@brewsync/db'
import {
  toBaseScaled,
  perUnitQty,
  type RecipeComponent,
  type RecipeGraph,
} from '@brewsync/shared'
import { badRequest, notFound } from '../http-error.js'

type Tx = Prisma.TransactionClient

export interface RecipeItemInput {
  componentVariantId: string
  componentType: 'INGREDIENT' | 'PRODUCT'
  /** Quantity in `recipeUnitId`, scaled by UNIT_FACTOR_SCALE, positive. */
  qtyScaled: bigint
  recipeUnitId: string
  sortOrder?: number
}

export interface UpsertRecipeInput {
  variantId: string
  /** Finished units one authoring of this recipe yields, scaled. Default 1. */
  yieldQtyScaled?: bigint
  notes?: string | null
  isActive?: boolean
  items: RecipeItemInput[]
}

export class RecipeService {
  constructor(private readonly db: BrewsyncClient) {}

  /** The recipe for a variant with its items in order, or null if none. */
  async getForVariant(variantId: string) {
    return await this.db.recipe.findUnique({
      where: { variantId },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    })
  }

  /**
   * Creates or replaces a variant's recipe (the editor's Save). The item set is
   * replaced wholesale in one transaction. Validates that every component and
   * recipe unit resolves, that no line makes the variant its own direct
   * component, and that quantities are positive.
   */
  async upsert(input: UpsertRecipeInput) {
    requireTenantContext()
    const yieldQty = input.yieldQtyScaled ?? 1_000_000n
    if (yieldQty <= 0n) throw badRequest('INVALID_YIELD', 'Recipe yield must be positive.')
    if (input.items.length === 0) {
      throw badRequest('EMPTY_RECIPE', 'A recipe needs at least one component.')
    }
    for (const item of input.items) {
      if (item.qtyScaled <= 0n) {
        throw badRequest('INVALID_QTY', 'Each recipe component quantity must be positive.')
      }
      if (item.componentVariantId === input.variantId) {
        throw badRequest('SELF_COMPONENT', 'A recipe cannot list its own output as a component.')
      }
    }

    return this.inTx(async (tx) => {
      await this.requireVariant(tx, input.variantId)
      await this.validateComponents(tx, input.items)

      const notes = input.notes?.trim() ? input.notes.trim() : null
      const recipe = await tx.recipe.upsert({
        where: { variantId: input.variantId },
        create: {
          variantId: input.variantId,
          yieldQtyScaled: yieldQty,
          notes,
          isActive: input.isActive ?? true,
        } as unknown as Prisma.RecipeCreateInput,
        update: {
          yieldQtyScaled: yieldQty,
          notes,
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
        select: { id: true },
      })

      // Replace-all: drop the old lines, insert the new set. Simpler and safer
      // than diffing — the editor always submits the complete recipe.
      await tx.recipeItem.deleteMany({ where: { recipeId: recipe.id } })
      await tx.recipeItem.createMany({
        data: input.items.map((item, i) => ({
          tenantId: requireTenantContext().tenantId,
          recipeId: recipe.id,
          componentVariantId: item.componentVariantId,
          componentType: item.componentType,
          qtyScaled: item.qtyScaled,
          recipeUnitId: item.recipeUnitId,
          sortOrder: item.sortOrder ?? i,
        })) as unknown as Prisma.RecipeItemCreateManyInput[],
      })

      return this.loadWithItems(tx, recipe.id)
    })
  }

  /** Deletes a variant's recipe entirely (the editor's "remove recipe"). */
  async remove(variantId: string) {
    requireTenantContext()
    return this.inTx(async (tx) => {
      const recipe = await tx.recipe.findUnique({ where: { variantId }, select: { id: true } })
      if (!recipe) throw notFound('RECIPE_NOT_FOUND', `No recipe for variant ${variantId}.`)
      await tx.recipe.delete({ where: { id: recipe.id } })
      return { variantId }
    })
  }

  /**
   * Assembles the recipe graph reachable from `rootVariantId` for the pure
   * `explodeRecipe` helper (S6-02). Walks recipes breadth-first, loading each
   * referenced sub-product's recipe once, and normalises every component
   * quantity into that component's own scaled base units, divided down to a
   * per-one-finished-base-unit basis so `explodeRecipe` can multiply by a raw
   * sale quantity. Returns an empty map if the root has no recipe (a STOCKED
   * item deducts itself, handled by the caller).
   *
   * Cycle safety is the explode helper's concern; this loader only guards
   * against loading the same recipe twice.
   */
  async loadGraph(
    client: Tx | BrewsyncClient,
    rootVariantId: string
  ): Promise<RecipeGraph> {
    const graph = new Map<string, RecipeComponent[]>()
    const queue: string[] = [rootVariantId]
    const visited = new Set<string>()

    while (queue.length > 0) {
      const variantId = queue.shift() as string
      if (visited.has(variantId)) continue
      visited.add(variantId)

      // Narrow the Tx | BrewsyncClient union to one concrete client before the
      // query: unioning two deeply-generic Prisma method signatures pushes TS
      // past its instantiation-depth limit. Both members read identically.
      const recipe = await (client as BrewsyncClient).recipe.findUnique({
        where: { variantId },
        include: {
          items: {
            include: {
              recipeUnit: { select: { factor: true } },
              componentVariant: { select: { stockUnit: { select: { factor: true } } } },
            },
          },
        },
      })
      if (!recipe || !recipe.isActive || recipe.items.length === 0) continue

      const components: RecipeComponent[] = recipe.items.map((item) => {
        // recipe-unit qty → the component's own scaled base units.
        const componentBaseScaled = toBaseScaled(item.qtyScaled, item.recipeUnit.factor)
        // Batch recipes state component qty per whole yield; bring to per one
        // finished base unit so the explode multiplier is a plain sale qty.
        const perUnit = perUnitQty(componentBaseScaled, recipe.yieldQtyScaled)
        return {
          componentVariantId: item.componentVariantId,
          componentType: item.componentType as 'INGREDIENT' | 'PRODUCT',
          qtyBaseScaled: perUnit,
        }
      })
      graph.set(variantId, components)

      for (const item of recipe.items) {
        if (item.componentType === 'PRODUCT' && !visited.has(item.componentVariantId)) {
          queue.push(item.componentVariantId)
        }
      }
    }

    return graph
  }

  /* ---------------------------------------------------------------- internals */

  private inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.db as unknown as PrismaClient, fn)
  }

  private async loadWithItems(tx: Tx, recipeId: string) {
    const recipe = await tx.recipe.findUnique({
      where: { id: recipeId },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    })
    if (!recipe) throw notFound('RECIPE_NOT_FOUND', `Recipe ${recipeId} not found.`)
    return recipe
  }

  private async requireVariant(tx: Tx, variantId: string): Promise<void> {
    const variant = await tx.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true },
    })
    if (!variant) throw notFound('VARIANT_NOT_FOUND', `Variant ${variantId} not found.`)
  }

  /**
   * Every component variant and recipe unit must exist (and belong to the tenant
   * — the extension scopes these reads). A missing reference is a 400, not a DB
   * FK explosion later. A PRODUCT component with no recipe is allowed (it is
   * treated as a leaf by explosion) but must at least be a real variant.
   */
  private async validateComponents(tx: Tx, items: RecipeItemInput[]): Promise<void> {
    const variantIds = [...new Set(items.map((i) => i.componentVariantId))]
    const unitIds = [...new Set(items.map((i) => i.recipeUnitId))]

    const [variants, units] = await Promise.all([
      tx.productVariant.findMany({ where: { id: { in: variantIds } }, select: { id: true } }),
      tx.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true } }),
    ])
    const foundVariants = new Set(variants.map((v) => v.id))
    const foundUnits = new Set(units.map((u) => u.id))

    for (const id of variantIds) {
      if (!foundVariants.has(id)) {
        throw badRequest('COMPONENT_NOT_FOUND', `Component variant ${id} not found.`)
      }
    }
    for (const id of unitIds) {
      if (!foundUnits.has(id)) {
        throw badRequest('RECIPE_UNIT_NOT_FOUND', `Recipe unit ${id} not found.`)
      }
    }
  }
}
