/**
 * Products screen — S3-07 headline: a virtualized list (a menu can run to
 * hundreds of items) with search + category filter, and a create/edit form.
 *
 * The list is virtualized with @tanstack/react-virtual so only the visible rows
 * mount (design §19: virtualize long product lists, assume mid-range devices).
 * Edit buttons hide without product.edit — UX only; the backend guards writes.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { PERMISSIONS } from '@brewsync/shared'
import { useProductsStore } from '../../stores/products.store.ts'
import { useCategoriesStore } from '../../stores/categories.store.ts'
import { usePermission } from '../../hooks/usePermission.ts'
import { minorToInput } from '../../lib/money-input.ts'
import { buildCategoryTree, flattenTree } from '../../lib/category-tree.ts'
import type { Product, ProductListItem } from '../../lib/types.ts'
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Input,
  Select,
  Spinner,
} from '../../ui/primitives.tsx'
import { ProductForm, submitProductDraft } from './ProductForm.tsx'

function defaultPrice(item: ProductListItem): string {
  const variant = item.variants.find((v) => v.isDefault) ?? item.variants[0]
  return variant ? minorToInput(variant.basePrice) : '—'
}

export function ProductsScreen(): ReactNode {
  const { items, loading, error, list, getById, create, update } = useProductsStore()
  const categories = useCategoriesStore((s) => s.items)
  const listCategories = useCategoriesStore((s) => s.list)
  const canEdit = usePermission(PERMISSIONS.PRODUCT_EDIT)

  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)

  useEffect(() => {
    void list({ includeInactive: true })
    void listCategories({ includeInactive: true })
  }, [list, listCategories])

  const categoryOptions = useMemo(
    () => flattenTree(buildCategoryTree(categories)),
    [categories]
  )
  const categoryName = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of categories) map.set(c.id, c.name)
    return map
  }, [categories])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((p) => {
      if (categoryId && p.categoryId !== categoryId) return false
      if (q === '') return true
      if (p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q)) return true
      return p.variants.some((v) => v.sku.toLowerCase().includes(q))
    })
  }, [items, search, categoryId])

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
  })

  const openCreate = (): void => {
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = async (id: string): Promise<void> => {
    // The list item is a summary; fetch the full product for the editor.
    const full = await getById(id)
    setEditing(full)
    setFormOpen(true)
  }

  return (
    <div className="flex h-[calc(100vh_-_6rem)] flex-col gap-4 sm:h-[calc(100vh_-_4rem)]">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-ink">Products</h1>
        {canEdit ? <Button onClick={openCreate}>New product</Button> : null}
      </header>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          className="flex-1"
          placeholder="Search name, slug or SKU…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          className="sm:w-64"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">All categories</option>
          {categoryOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {`${'  '.repeat(c.depth)}${c.name}`}
            </option>
          ))}
        </Select>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-surface">
        {loading && items.length === 0 ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No products"
            hint={items.length === 0 ? 'Create your first product to get started.' : 'No matches for this filter.'}
          />
        ) : (
          <div ref={scrollRef} className="h-full overflow-y-auto">
            <div
              style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}
            >
              {virtualizer.getVirtualItems().map((row) => {
                const p = filtered[row.index]
                if (!p) return null
                return (
                  <div
                    key={p.id}
                    className="absolute left-0 top-0 flex w-full items-center gap-3 border-b border-line px-4"
                    style={{ height: `${row.size}px`, transform: `translateY(${row.start}px)` }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-ink">{p.name}</p>
                        {!p.isActive ? <Badge tone="muted">Inactive</Badge> : null}
                      </div>
                      <p className="truncate text-xs text-ink-muted">
                        {p.categoryId ? (categoryName.get(p.categoryId) ?? '—') : 'Uncategorized'}
                        {' · '}
                        {p.variants.length} variant{p.variants.length === 1 ? '' : 's'}
                      </p>
                    </div>
                    <div className="shrink-0 text-right text-sm tabular-nums text-ink">
                      {defaultPrice(p)}
                    </div>
                    {canEdit ? (
                      <Button
                        variant="secondary"
                        onClick={() => void openEdit(p.id)}
                        className="h-9 shrink-0 px-3 text-xs"
                      >
                        Edit
                      </Button>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {formOpen ? (
        <ProductForm
          product={editing}
          categories={categories}
          onClose={() => setFormOpen(false)}
          onSubmit={(draft) => submitProductDraft(draft, editing, create, update)}
        />
      ) : null}
    </div>
  )
}
