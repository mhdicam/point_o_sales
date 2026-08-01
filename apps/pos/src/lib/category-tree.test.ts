import { describe, expect, it } from 'vitest'
import { buildCategoryTree, descendantIds, flattenTree } from './category-tree.ts'
import type { Category } from './types.ts'

function cat(id: string, parentId: string | null, sortOrder = 0): Category {
  return {
    id,
    name: id,
    slug: id,
    parentId,
    sortOrder,
    isActive: true,
    defaultTaxRateBp: null,
    defaultStationId: null,
    reportGroup: null,
  }
}

describe('buildCategoryTree', () => {
  it('nests children under parents and assigns depth', () => {
    const roots = buildCategoryTree([
      cat('a', null),
      cat('a1', 'a'),
      cat('a1x', 'a1'),
      cat('b', null),
    ])

    expect(roots.map((r) => r.id)).toEqual(['a', 'b'])
    const a = roots[0]!
    expect(a.depth).toBe(0)
    expect(a.children.map((c) => c.id)).toEqual(['a1'])
    expect(a.children[0]!.depth).toBe(1)
    expect(a.children[0]!.children[0]!.id).toBe('a1x')
    expect(a.children[0]!.children[0]!.depth).toBe(2)
  })

  it('preserves input order at each level (API pre-sorts)', () => {
    const roots = buildCategoryTree([
      cat('b', null, 1),
      cat('a', null, 0),
      cat('a2', 'a', 1),
      cat('a1', 'a', 0),
    ])
    expect(roots.map((r) => r.id)).toEqual(['b', 'a'])
    expect(roots[1]!.children.map((c) => c.id)).toEqual(['a2', 'a1'])
  })

  it('treats a child of a missing parent as a root (nothing disappears)', () => {
    const roots = buildCategoryTree([cat('orphan', 'gone')])
    expect(roots.map((r) => r.id)).toEqual(['orphan'])
    expect(roots[0]!.depth).toBe(0)
  })
})

describe('flattenTree', () => {
  it('returns nodes in pre-order', () => {
    const roots = buildCategoryTree([
      cat('a', null),
      cat('a1', 'a'),
      cat('b', null),
    ])
    expect(flattenTree(roots).map((n) => n.id)).toEqual(['a', 'a1', 'b'])
  })
})

describe('descendantIds', () => {
  it('blocks self and all descendants as candidate parents', () => {
    const cats = [cat('a', null), cat('a1', 'a'), cat('a1x', 'a1'), cat('b', null)]
    const blocked = descendantIds(cats, 'a')
    expect([...blocked].sort()).toEqual(['a', 'a1', 'a1x'])
    expect(blocked.has('b')).toBe(false)
  })

  it('handles a leaf (only itself)', () => {
    const cats = [cat('a', null), cat('a1', 'a')]
    expect([...descendantIds(cats, 'a1')]).toEqual(['a1'])
  })
})
