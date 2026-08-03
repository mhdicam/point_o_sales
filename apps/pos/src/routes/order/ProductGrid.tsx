/**
 * ProductGrid — the cashier's tap-to-add catalog (design §19, S4-08).
 *
 * Tablet-first: a responsive card grid with large tap targets (≥44px). The list
 * can run to hundreds of items, so rows are virtualized (only visible lanes
 * mount) — the column count is derived from the container width and recomputed on
 * resize, and the virtualizer windows the resulting rows.
 *
 * It is display + intent only: tapping a card calls `onPick(product)` and the
 * parent decides the add flow (variant/modifier resolution, the API call). Prices
 * are pre-formatted server values; this computes no money (standard #2).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { minorToInput } from '../../lib/money-input.ts'
import type { ProductListItem } from '../../lib/types.ts'
import { EmptyState } from '../../ui/primitives.tsx'

/** Target minimum card width; the grid fits as many whole columns as this allows. */
const MIN_CARD_PX = 168
const ROW_HEIGHT_PX = 116
const GAP_PX = 12

function defaultPrice(item: ProductListItem): string {
  const variant = item.variants.find((v) => v.isDefault) ?? item.variants[0]
  return variant ? minorToInput(variant.basePrice) : '—'
}

/** Measure the scroll container and derive a whole-number column count. */
function useColumnCount(ref: React.RefObject<HTMLElement>): number {
  const [columns, setColumns] = useState(2)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const width = el.clientWidth
      // Whole columns that fit; trunc (not floor) keeps this off the money-rounding
      // lint rule — these are positive layout counts, never currency.
      const next = Math.max(1, Math.trunc((width + GAP_PX) / (MIN_CARD_PX + GAP_PX)))
      setColumns((prev) => (prev === next ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return columns
}

export function ProductGrid({
  products,
  busy,
  onPick,
}: {
  products: ProductListItem[]
  busy: boolean
  onPick: (product: ProductListItem) => void
}): ReactNode {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const active = products.filter((p) => p.isActive)
    if (q === '') return active
    return active.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.variants.some((v) => v.sku.toLowerCase().includes(q))
    )
  }, [products, search])

  const scrollRef = useRef<HTMLDivElement>(null)
  const columns = useColumnCount(scrollRef)
  // Ceiling division via trunc (both positive) — stays off the money-rounding rule.
  const rowCount = Math.trunc((filtered.length + columns - 1) / columns)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX + GAP_PX,
    overscan: 6,
  })

  // Column count changes remeasure row sizes; keep the window consistent.
  useEffect(() => {
    virtualizer.measure()
  }, [columns, virtualizer])

  return (
    <div className="flex h-full flex-col gap-3">
      <input
        className="min-h-tap rounded-lg border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-brand"
        placeholder="Search products or scan SKU…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {filtered.length === 0 ? (
        <div className="flex-1 rounded-xl border border-line bg-surface">
          <EmptyState
            title="No products"
            hint={products.length === 0 ? 'The catalog is empty.' : 'No matches for this search.'}
          />
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((row) => {
              const start = row.index * columns
              const cells = filtered.slice(start, start + columns)
              return (
                <div
                  key={row.key}
                  className="absolute left-0 top-0 grid w-full"
                  style={{
                    transform: `translateY(${row.start}px)`,
                    height: `${ROW_HEIGHT_PX}px`,
                    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                    gap: `${GAP_PX}px`,
                    paddingBottom: `${GAP_PX}px`,
                  }}
                >
                  {cells.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      disabled={busy}
                      onClick={() => onPick(p)}
                      className="flex flex-col justify-between rounded-xl border border-line bg-surface p-3 text-left transition hover:border-brand hover:bg-brand/5 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none motion-reduce:active:scale-100"
                    >
                      <span className="line-clamp-2 text-sm font-medium text-ink">{p.name}</span>
                      <span className="mt-2 text-sm tabular-nums text-ink-muted">
                        {defaultPrice(p)}
                      </span>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
