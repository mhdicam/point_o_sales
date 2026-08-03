/**
 * Inventory screen — S6-09, design §4 (sprint plan: "stock opname (ADJUSTMENT)").
 * Feature-agnostic (inventory exists for every profile that stocks anything), but
 * gated on the `inventory.view` permission for reads and `inventory.adjust` for
 * the stock-opname form — the backend re-checks both (standard #5).
 *
 * Shows the outlet's valuation summary (on-hand + value per variant, folded from
 * the append-only ledger server-side — the FE never sums, standard #3), an
 * inventory-card drawer per variant, and a stock-opname / waste modal. Needs an
 * outlet-scoped session; without one it explains rather than erroring.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { PERMISSIONS, formatMoney } from '@brewsync/shared'
import { useInventoryStore } from '../stores/inventory.store.ts'
import { useProductsStore } from '../stores/products.store.ts'
import { useAuthStore } from '../stores/auth.store.ts'
import { usePermission } from '../hooks/usePermission.ts'
import { formatScaledQty } from '../lib/scaled.ts'
import { AdjustStockModal } from './inventory/AdjustStockModal.tsx'
import { InventoryCard } from './inventory/InventoryCard.tsx'
import { Badge, Button, EmptyState, ErrorBanner, Spinner } from '../ui/primitives.tsx'

/** variantId → a readable label, assembled from the product list. */
export interface VariantLabel {
  variantId: string
  label: string
  sku: string
}

export function InventoryScreen(): ReactNode {
  const outletId = useAuthStore((s) => s.scope?.outletId ?? null)
  const { valuation, loading, loaded, error, load, clear } = useInventoryStore()
  const products = useProductsStore((s) => s.items)
  const listProducts = useProductsStore((s) => s.list)
  const canAdjust = usePermission(PERMISSIONS.INVENTORY_ADJUST)

  const [adjustOpen, setAdjustOpen] = useState(false)

  useEffect(() => {
    if (outletId) {
      void load(outletId)
      void listProducts({ includeInactive: true })
    }
    return () => clear()
  }, [outletId, load, listProducts, clear])

  // A flat variant lookup so the value table and the card show names, not ids.
  const variantLabels = useMemo<Map<string, VariantLabel>>(() => {
    const map = new Map<string, VariantLabel>()
    for (const p of products) {
      for (const v of p.variants) {
        const label = v.name && v.name !== p.name ? `${p.name} · ${v.name}` : p.name
        map.set(v.id, { variantId: v.id, label, sku: v.sku })
      }
    }
    return map
  }, [products])

  // Only STOCKED / stock-bearing variants make sense to adjust; the whole set is
  // offered (the backend rejects a variant with no stock unit) sorted by label.
  const allVariants = useMemo<VariantLabel[]>(
    () => [...variantLabels.values()].sort((a, b) => a.label.localeCompare(b.label)),
    [variantLabels]
  )

  if (!outletId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold text-ink">Inventory</h1>
        <ErrorBanner message="This screen needs an outlet-scoped session. Re-select your scope with an outlet." />
      </div>
    )
  }

  const labelFor = (variantId: string): string =>
    variantLabels.get(variantId)?.label ?? variantId

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Inventory</h1>
          {valuation ? (
            <p className="text-xs text-ink-muted">
              Total value {formatMoney(BigInt(valuation.totalValue))}
            </p>
          ) : null}
        </div>
        {canAdjust ? <Button onClick={() => setAdjustOpen(true)}>Stock opname</Button> : null}
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      {loading && !loaded ? (
        <Spinner />
      ) : !valuation || valuation.lines.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState
            title="No stock movements yet"
            hint="Receive a purchase order or record a stock opname to build the ledger."
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-muted">
                <th className="px-4 py-2 font-medium">Item</th>
                <th className="px-4 py-2 text-right font-medium">On hand</th>
                <th className="px-4 py-2 text-right font-medium">Avg cost</th>
                <th className="px-4 py-2 text-right font-medium">Value</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {valuation.lines.map((line) => (
                <InventoryRow
                  key={line.variantId}
                  label={labelFor(line.variantId)}
                  onHandStockScaled={line.onHandStockScaled}
                  avgCost={line.avgCost}
                  value={line.value}
                  variantId={line.variantId}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <InventoryCard labelFor={labelFor} />

      {adjustOpen ? (
        <AdjustStockModal variants={allVariants} onClose={() => setAdjustOpen(false)} />
      ) : null}
    </div>
  )
}

function InventoryRow({
  label,
  onHandStockScaled,
  avgCost,
  value,
  variantId,
}: {
  label: string
  onHandStockScaled: string
  avgCost: string
  value: string
  variantId: string
}): ReactNode {
  const openCard = useInventoryStore((s) => s.openCard)
  const negative = BigInt(onHandStockScaled) < 0n
  return (
    <tr className="border-b border-line last:border-b-0">
      <td className="px-4 py-3">
        <span className="text-sm font-medium text-ink">{label}</span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        <span className={negative ? 'font-semibold text-danger' : 'text-ink'}>
          {formatScaledQty(onHandStockScaled)}
        </span>
        {negative ? (
          <Badge tone="muted">
            <span className="ml-1">negative</span>
          </Badge>
        ) : null}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-ink-muted">
        {formatMoney(BigInt(avgCost))}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-ink">{formatMoney(BigInt(value))}</td>
      <td className="px-4 py-3 text-right">
        <Button
          variant="ghost"
          onClick={() => void openCard(variantId)}
          className="h-9 px-3 text-xs"
        >
          Card
        </Button>
      </td>
    </tr>
  )
}
