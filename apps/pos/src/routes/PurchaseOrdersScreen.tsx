/**
 * Purchase orders screen — S6-09, design §4.5 (sprint plan: "buat/approve/terima
 * PO"). Feature-gated behind `purchasing`; reads + drafts need `purchase.create`,
 * approve/cancel need `purchase.approve`, receipt needs `purchase.receive` — the
 * backend re-checks all three (standard #5). Needs an outlet-scoped session.
 *
 * Left: the PO list (newest poNumber first) with status. Right/overlay: the open
 * PO detail with its lifecycle actions. A create modal drafts a new PO. All money
 * and quantities are server-derived / frozen at APPROVED (standard #7) — the FE
 * renders them, it never recomputes a total.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { PERMISSIONS, formatMoney } from '@brewsync/shared'
import { usePurchaseOrdersStore } from '../stores/purchase-orders.store.ts'
import { useSuppliersStore } from '../stores/suppliers.store.ts'
import { useProductsStore } from '../stores/products.store.ts'
import { useAuthStore } from '../stores/auth.store.ts'
import { usePermission } from '../hooks/usePermission.ts'
import type { PurchaseOrderStatus } from '../lib/types.ts'
import { CreatePurchaseOrderModal } from './purchase-orders/CreatePurchaseOrderModal.tsx'
import { PurchaseOrderDetail, type VariantLabel } from './purchase-orders/PurchaseOrderDetail.tsx'
import { Badge, Button, EmptyState, ErrorBanner, Spinner } from '../ui/primitives.tsx'

/** Status → badge tone. Terminal-good is active, in-flight neutral, dead muted. */
const STATUS_TONE: Record<PurchaseOrderStatus, 'neutral' | 'active' | 'muted'> = {
  DRAFT: 'muted',
  SUBMITTED: 'neutral',
  APPROVED: 'active',
  RECEIVING: 'neutral',
  RECEIVED: 'active',
  CLOSED: 'muted',
  CANCELLED: 'muted',
}

export function PurchaseOrdersScreen(): ReactNode {
  const outletId = useAuthStore((s) => s.scope?.outletId ?? null)
  const { orders, detail, loading, loaded, error, load, open, closeDetail, clear } =
    usePurchaseOrdersStore()
  const suppliers = useSuppliersStore((s) => s.suppliers)
  const listSuppliers = useSuppliersStore((s) => s.list)
  const products = useProductsStore((s) => s.items)
  const listProducts = useProductsStore((s) => s.list)
  const canCreate = usePermission(PERMISSIONS.PURCHASE_CREATE)

  const [createOpen, setCreateOpen] = useState(false)

  useEffect(() => {
    if (outletId) {
      void load(outletId)
      void listSuppliers({ includeInactive: true })
      void listProducts({ includeInactive: true })
    }
    return () => clear()
  }, [outletId, load, listSuppliers, listProducts, clear])

  const supplierName = useMemo(() => {
    const map = new Map(suppliers.map((s) => [s.id, s.name]))
    return (id: string): string => map.get(id) ?? id
  }, [suppliers])

  // Variant labels for the create + detail line tables.
  const variantLabels = useMemo<VariantLabel[]>(() => {
    const out: VariantLabel[] = []
    for (const p of products) {
      for (const v of p.variants) {
        const label = v.name && v.name !== p.name ? `${p.name} · ${v.name}` : p.name
        out.push({ variantId: v.id, label, sku: v.sku })
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label))
  }, [products])

  const labelFor = useMemo(() => {
    const map = new Map(variantLabels.map((v) => [v.variantId, v.label]))
    return (id: string): string => map.get(id) ?? id
  }, [variantLabels])

  if (!outletId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold text-ink">Purchase orders</h1>
        <ErrorBanner message="This screen needs an outlet-scoped session. Re-select your scope with an outlet." />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-ink">Purchase orders</h1>
        {canCreate ? <Button onClick={() => setCreateOpen(true)}>New PO</Button> : null}
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      {loading && !loaded ? (
        <Spinner />
      ) : orders.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState title="No purchase orders" hint="Raise a PO to order stock from a supplier." />
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-surface">
          <ul>
            {orders.map((po) => (
              <li key={po.id}>
                <button
                  className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-surface-muted"
                  onClick={() => void open(po.id)}
                >
                  <span className="font-mono text-sm font-semibold text-ink">
                    #{po.poNumber}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="truncate text-sm text-ink">{supplierName(po.supplierId)}</span>
                    <span className="block text-xs text-ink-muted">
                      {po.items.length} line{po.items.length === 1 ? '' : 's'} ·{' '}
                      {formatMoney(BigInt(po.total))}
                    </span>
                  </div>
                  <Badge tone={STATUS_TONE[po.status]}>{po.status}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail ? (
        <PurchaseOrderDetail
          po={detail}
          supplierName={supplierName(detail.supplierId)}
          labelFor={labelFor}
          onClose={closeDetail}
        />
      ) : null}

      {createOpen ? (
        <CreatePurchaseOrderModal
          outletId={outletId}
          suppliers={suppliers.filter((s) => s.isActive)}
          variants={variantLabels}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </div>
  )
}
