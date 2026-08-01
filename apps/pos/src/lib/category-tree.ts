/**
 * Category tree — pure transform from the API's flat, display-ordered list into
 * a parent/child tree for rendering, plus helpers the pickers need.
 *
 * The API returns categories flat (category.service.list) already sorted by
 * (sortOrder, name); this preserves that order at every level. Kept pure and
 * dependency-free so it is trivially unit-testable (task S3-07 / #21).
 */

import type { Category } from './types.ts'

export interface CategoryNode extends Category {
  depth: number
  children: CategoryNode[]
}

/**
 * Build a forest from a flat list. Nodes whose parentId points at a category not
 * present in the list (filtered out, or a stale reference) are treated as roots
 * so nothing silently disappears from the admin view.
 */
export function buildCategoryTree(categories: Category[]): CategoryNode[] {
  const byId = new Map<string, CategoryNode>()
  for (const c of categories) {
    byId.set(c.id, { ...c, depth: 0, children: [] })
  }

  const roots: CategoryNode[] = []
  for (const c of categories) {
    const node = byId.get(c.id)
    if (!node) continue
    const parent = c.parentId ? byId.get(c.parentId) : undefined
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // Assign depth by walking from the roots so it is correct regardless of input
  // order.
  const assignDepth = (nodes: CategoryNode[], depth: number): void => {
    for (const n of nodes) {
      n.depth = depth
      assignDepth(n.children, depth + 1)
    }
  }
  assignDepth(roots, 0)

  return roots
}

/**
 * Flatten a tree back to a depth-annotated list in display (pre-order) sequence,
 * so a `<select>` or an indented list can render the hierarchy from one array.
 */
export function flattenTree(nodes: CategoryNode[]): CategoryNode[] {
  const out: CategoryNode[] = []
  const walk = (list: CategoryNode[]): void => {
    for (const n of list) {
      out.push(n)
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/**
 * IDs that must NOT be offered as a new parent for `categoryId`: itself and all
 * of its descendants. Choosing one of those would create a cycle, which the
 * backend rejects — this keeps the picker from even presenting the illegal
 * option (UX only; standard #5).
 */
export function descendantIds(categories: Category[], categoryId: string): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const c of categories) {
    if (!c.parentId) continue
    const list = childrenOf.get(c.parentId) ?? []
    list.push(c.id)
    childrenOf.set(c.parentId, list)
  }

  const blocked = new Set<string>([categoryId])
  const stack = [categoryId]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    for (const child of childrenOf.get(current) ?? []) {
      if (!blocked.has(child)) {
        blocked.add(child)
        stack.push(child)
      }
    }
  }
  return blocked
}
