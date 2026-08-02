/**
 * Recipe / BOM explosion — S6-03, design §3.4 (standard #3 feeds this).
 *
 * A `MADE_TO_ORDER` variant carries a recipe: a list of components, each either
 * a base INGREDIENT or another PRODUCT variant that itself has a recipe. Selling
 * one drives consumption all the way down to the base ingredients through the
 * recipe chain ("Kopi Susu" → 30 ml "Simple Syrup" → gula + air).
 *
 * This module is the pure core of that walk: given the recipe graph as plain
 * data, it flattens a sale of N units of a variant into a map of base-ingredient
 * variant → total scaled-base quantity. It holds no DB and no float — quantities
 * are scaled base units (see {@link ./inventory}). The service loads the graph
 * and writes the movements; the arithmetic and the cycle guard live here so they
 * can be tested exhaustively without a database.
 */

import { UNIT_FACTOR_SCALE } from './unit.js'

/** A component line of one recipe, reduced to what explosion needs. */
export interface RecipeComponent {
  /** The component variant consumed (an ingredient, or a sub-product variant). */
  componentVariantId: string
  /**
   * INGREDIENT stops the walk (a base item); PRODUCT recurses into that
   * variant's own recipe. Mirrors `RecipeItem.componentType`.
   */
  componentType: 'INGREDIENT' | 'PRODUCT'
  /**
   * Quantity of the component to make ONE of the parent, in scaled base units
   * of the component's own stock unit (already normalised by the caller).
   */
  qtyBaseScaled: bigint
}

/**
 * The recipe graph: variantId → its component lines. A variant absent from the
 * map (or mapped to an empty list) has no recipe and is treated as a leaf even
 * if a parent marked it PRODUCT — a half-defined recipe must not silently
 * vanish stock, so the explosion surfaces it as a leaf requirement instead.
 */
export type RecipeGraph = ReadonlyMap<string, readonly RecipeComponent[]>

/** A flattened requirement: how much of one base variant a sale consumes. */
export interface IngredientRequirement {
  variantId: string
  /** Total quantity across the whole explosion, scaled base units. */
  qtyBaseScaled: bigint
}

export class RecipeCycleError extends Error {
  constructor(readonly variantId: string, readonly path: readonly string[]) {
    super(
      `Recipe cycle detected at variant ${variantId} (path: ${[...path, variantId].join(' → ')}).`
    )
    this.name = 'RecipeCycleError'
  }
}

/**
 * Explode a sale of `qtyBaseScaled` base units of `rootVariantId` into base
 * ingredient requirements, folding repeated ingredients together.
 *
 * The walk multiplies down the chain: needing 2 of a parent that needs 30 ml of
 * a child needs 60 ml of the child. A PRODUCT component with its own recipe
 * recurses; an INGREDIENT — or a PRODUCT with no (or empty) recipe in the graph
 * — is a leaf and accumulates. A cycle (A needs B needs A) throws
 * {@link RecipeCycleError} rather than looping forever.
 *
 * `rootVariantId` itself is never emitted as a requirement — the caller decides
 * whether the finished item also holds stock. Only its recipe's leaves are.
 *
 * @param rootVariantId the variant being sold/produced
 * @param qtyBaseScaled how many base units of it, scaled
 * @param graph the full recipe graph (see {@link RecipeGraph})
 */
export function explodeRecipe(
  rootVariantId: string,
  qtyBaseScaled: bigint,
  graph: RecipeGraph
): IngredientRequirement[] {
  const totals = new Map<string, bigint>()

  const walk = (variantId: string, multiplier: bigint, path: readonly string[]): void => {
    if (path.includes(variantId)) {
      throw new RecipeCycleError(variantId, path)
    }
    const components = graph.get(variantId)
    if (!components || components.length === 0) {
      // A leaf. The root itself is not a requirement; only descendants are.
      if (path.length > 0) {
        totals.set(variantId, (totals.get(variantId) ?? 0n) + multiplier)
      }
      return
    }
    const nextPath = [...path, variantId]
    for (const c of components) {
      // Needing `multiplier` of this parent needs `multiplier * qty` of the
      // child. Quantities are scaled base units, so the product is scaled twice
      // and must be brought back to a single scale.
      const childQty = mulBaseScaled(multiplier, c.qtyBaseScaled)
      if (c.componentType === 'PRODUCT') {
        walk(c.componentVariantId, childQty, nextPath)
      } else {
        // INGREDIENT — a base leaf, accumulate directly.
        totals.set(c.componentVariantId, (totals.get(c.componentVariantId) ?? 0n) + childQty)
      }
    }
  }

  walk(rootVariantId, qtyBaseScaled, [])

  return [...totals.entries()].map(([variantId, qtyBaseScaled]) => ({ variantId, qtyBaseScaled }))
}

/**
 * Multiply two scaled-base quantities back to a single scale.
 *
 * Both operands are quantities × UNIT_FACTOR_SCALE. Their product carries the
 * scale twice, so divide it out once, rounding half away from zero to match the
 * rest of the inventory math (see {@link ./inventory}).
 */
function mulBaseScaled(a: bigint, b: bigint): bigint {
  const numerator = a * b
  const quotient = numerator / UNIT_FACTOR_SCALE
  const remainder = numerator % UNIT_FACTOR_SCALE
  if (remainder === 0n) return quotient
  const twice = (remainder < 0n ? -remainder : remainder) * 2n
  if (twice < UNIT_FACTOR_SCALE) return quotient
  return numerator < 0n ? quotient - 1n : quotient + 1n
}

/**
 * Normalise a per-batch component quantity to per one finished base unit.
 *
 * A recipe may yield more than one finished unit per authoring (a batch prep —
 * "this makes 1000 ml of syrup from …"). Its component quantities are stated
 * per batch, so a sale of one finished unit consumes `component / yield`. Both
 * inputs are scaled base units; the result is scaled base units of component per
 * one (scaled) base unit of the finished item, rounded half away from zero.
 *
 * @param componentBaseScaled component qty per whole batch, scaled base units
 * @param yieldBaseScaled finished units the batch yields, scaled base units
 */
export function perUnitQty(componentBaseScaled: bigint, yieldBaseScaled: bigint): bigint {
  if (yieldBaseScaled <= 0n) {
    throw new RangeError('Recipe yield must be positive.')
  }
  const numerator = componentBaseScaled * UNIT_FACTOR_SCALE
  const quotient = numerator / yieldBaseScaled
  const remainder = numerator % yieldBaseScaled
  if (remainder === 0n) return quotient
  const twice = (remainder < 0n ? -remainder : remainder) * 2n
  if (twice < yieldBaseScaled) return quotient
  return numerator < 0n ? quotient - 1n : quotient + 1n
}
