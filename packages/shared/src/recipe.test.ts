import { describe, it, expect } from 'vitest'
import {
  explodeRecipe,
  perUnitQty,
  RecipeCycleError,
  type RecipeComponent,
  type RecipeGraph,
} from './recipe.js'
import { UNIT_FACTOR_SCALE as SCALE } from './unit.js'

/** A scaled-base quantity from a whole number of base units. */
const base = (n: bigint) => n * SCALE

/** Build a graph from a plain object of variantId → components. */
function graph(entries: Record<string, RecipeComponent[]>): RecipeGraph {
  return new Map(Object.entries(entries))
}

const ing = (id: string, qtyBaseScaled: bigint): RecipeComponent => ({
  componentVariantId: id,
  componentType: 'INGREDIENT',
  qtyBaseScaled,
})
const prod = (id: string, qtyBaseScaled: bigint): RecipeComponent => ({
  componentVariantId: id,
  componentType: 'PRODUCT',
  qtyBaseScaled,
})

describe('explodeRecipe', () => {
  it('returns nothing for a variant with no recipe (a STOCKED leaf)', () => {
    expect(explodeRecipe('coffee', base(1n), graph({}))).toEqual([])
  })

  it('flattens a single-level recipe to its ingredients', () => {
    // 1 Kopi Susu = 18 g beans + 200 ml milk.
    const g = graph({ kopi: [ing('beans', base(18n)), ing('milk', base(200n))] })
    const out = explodeRecipe('kopi', base(1n), g)
    expect(out).toEqual([
      { variantId: 'beans', qtyBaseScaled: base(18n) },
      { variantId: 'milk', qtyBaseScaled: base(200n) },
    ])
  })

  it('scales linearly with the quantity sold', () => {
    // Selling 3 → 3× every leaf.
    const g = graph({ kopi: [ing('beans', base(18n)), ing('milk', base(200n))] })
    const out = explodeRecipe('kopi', base(3n), g)
    expect(out).toEqual([
      { variantId: 'beans', qtyBaseScaled: base(54n) },
      { variantId: 'milk', qtyBaseScaled: base(600n) },
    ])
  })

  it('recurses through a sub-product recipe down to base ingredients (§3.4)', () => {
    // Kopi Susu uses 30 ml Simple Syrup; Syrup itself is 1 g sugar + 1 ml water
    // per ml. Selling 1 Kopi → 30 g sugar + 30 ml water (+ its own beans).
    const g = graph({
      kopi: [ing('beans', base(18n)), prod('syrup', base(30n))],
      syrup: [ing('sugar', base(1n)), ing('water', base(1n))],
    })
    const out = explodeRecipe('kopi', base(1n), g)
    expect(new Map(out.map((r) => [r.variantId, r.qtyBaseScaled]))).toEqual(
      new Map([
        ['beans', base(18n)],
        ['sugar', base(30n)],
        ['water', base(30n)],
      ])
    )
  })

  it('folds an ingredient shared across branches into one total', () => {
    // Both the drink directly and its syrup use water; totals combine.
    const g = graph({
      kopi: [ing('water', base(50n)), prod('syrup', base(10n))],
      syrup: [ing('water', base(1n))],
    })
    const out = explodeRecipe('kopi', base(1n), g)
    const water = out.find((r) => r.variantId === 'water')
    expect(water?.qtyBaseScaled).toBe(base(60n)) // 50 direct + 10 via syrup
  })

  it('multiplies fractional sub-recipe quantities exactly', () => {
    // 2 Kopi, each 0.5 units of syrup, syrup 4 g sugar/unit → 2*0.5*4 = 4 g.
    const g = graph({
      kopi: [prod('syrup', SCALE / 2n)],
      syrup: [ing('sugar', base(4n))],
    })
    const out = explodeRecipe('kopi', base(2n), g)
    expect(out).toEqual([{ variantId: 'sugar', qtyBaseScaled: base(4n) }])
  })

  it('treats a PRODUCT component with no defined recipe as a leaf requirement', () => {
    // syrup is marked PRODUCT but absent from the graph — surface it, do not
    // silently drop the consumption.
    const g = graph({ kopi: [prod('syrup', base(30n))] })
    const out = explodeRecipe('kopi', base(1n), g)
    expect(out).toEqual([{ variantId: 'syrup', qtyBaseScaled: base(30n) }])
  })

  it('throws on a recipe cycle rather than looping forever', () => {
    const g = graph({
      a: [prod('b', base(1n))],
      b: [prod('a', base(1n))],
    })
    expect(() => explodeRecipe('a', base(1n), g)).toThrow(RecipeCycleError)
  })

  it('throws on a self-referential recipe', () => {
    const g = graph({ a: [prod('a', base(1n))] })
    expect(() => explodeRecipe('a', base(1n), g)).toThrow(RecipeCycleError)
  })
})

describe('perUnitQty', () => {
  it('is identity when the batch yields exactly one unit', () => {
    expect(perUnitQty(base(30n), base(1n))).toBe(base(30n))
  })

  it('divides a batch quantity by its yield (1000 ml syrup from 1000 g sugar)', () => {
    // 1000 g sugar per 1000 ml batch → 1 g per ml.
    expect(perUnitQty(base(1000n), base(1000n))).toBe(base(1n))
  })

  it('keeps a fractional per-unit result exact', () => {
    // 3 g over a yield of 2 → 1.5 g per unit.
    expect(perUnitQty(base(3n), base(2n))).toBe(base(1n) + SCALE / 2n)
  })

  it('throws on a non-positive yield', () => {
    expect(() => perUnitQty(base(1n), 0n)).toThrow(RangeError)
    expect(() => perUnitQty(base(1n), -base(1n))).toThrow(RangeError)
  })
})
