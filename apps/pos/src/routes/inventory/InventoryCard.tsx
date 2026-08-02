/**
 * Inventory card — S6-09, design §4.3. A drawer listing the append-only ledger
 * for one variant at the outlet (newest first), the audit trail behind its
 * on-hand. Read-only: every row is a StockMovement, and on-hand is their signed
 * SUM (standard #3). Opened from a row's "Card" button; driven by the store's
 * `cardVariantId`/`card`.
 */

import type { ReactNode } from 'react'
import { formatMoney } from '@brewsync/shared'
import { useInventoryStore } from '../../stores/inventory.store.ts'
import type { StockMovementType } from '../../lib/types.ts'
import { formatScaledQty } from '../../lib/scaled.ts'
import { Modal } from '../../ui/Modal.tsx'
import { Badge, EmptyState } from '../../ui/primitives.tsx'

const TYPE_LABEL: Record<StockMovementType, string> = {
  ADJUSTMENT: 'Adjustment',
  WASTE: 'Waste',
  TRANSFER: 'Transfer',
  PRODUCTION: 'Production',
  SALE_CONSUMPTION: 'Sale',
  PURCHASE: 'Purchase',
}

export function InventoryCard({
  labelFor,
}: {
  labelFor: (variantId: string) => string
}): ReactNode {
  const cardVariantId = useInventoryStore((s) => s.cardVariantId)
  const card = useInventoryStore((s) => s.card)
  const closeCard = useInventoryStore((s) => s.closeCard)

  if (!cardVariantId) return null

  return (
    <Modal title={`Inventory card — ${labelFor(cardVariantId)}`} onClose={closeCard}>
      {card.length === 0 ? (
        <EmptyState title="No movements" hint="This item has no ledger rows at this outlet yet." />
      ) : (
        <ul className="flex flex-col">
          {card.map((m) => {
            const qty = BigInt(m.qty)
            const inbound = qty >= 0n
            return (
              <li
                key={m.id}
                className="flex items-center justify-between gap-3 border-b border-line py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge tone={inbound ? 'active' : 'muted'}>{TYPE_LABEL[m.type]}</Badge>
                    <span className="truncate text-xs text-ink-muted">
                      {new Date(m.createdAt).toLocaleString('id-ID')}
                    </span>
                  </div>
                  {m.reason ? <p className="mt-1 text-xs text-ink-muted">{m.reason}</p> : null}
                </div>
                <div className="text-right tabular-nums">
                  <span className={inbound ? 'text-sm text-ink' : 'text-sm text-danger'}>
                    {inbound ? '+' : ''}
                    {formatScaledQty(m.qty)}
                  </span>
                  {m.costPerUnit ? (
                    <p className="text-xs text-ink-muted">@ {formatMoney(BigInt(m.costPerUnit))}</p>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
