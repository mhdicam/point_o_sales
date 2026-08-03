/**
 * OrderLineRow — one line in the running order.
 *
 * While OPEN the cashier can change qty and remove the line; both freeze at SENT
 * (standard #7), after which the correction path is a single-line void. Which
 * controls appear is the AND of the status-legal flags (from `buildOrderView`)
 * and the caller's permission checks (standard #5) — this component only renders
 * what it is handed callbacks for. All money is pre-formatted; it computes none.
 */

import type { ReactNode } from 'react'
import type { OrderLineView } from '../../lib/order-view.ts'
import { Button } from '../../ui/primitives.tsx'

export function OrderLineRow({
  line,
  canEditItems,
  canVoidItem,
  canDiscount,
  busy,
  onChangeQty,
  onRemove,
  onVoid,
  onDiscount,
}: {
  line: OrderLineView
  canEditItems: boolean
  canVoidItem: boolean
  canDiscount: boolean
  busy: boolean
  onChangeQty: (qty: number) => void
  onRemove: () => void
  onVoid: () => void
  onDiscount: () => void
}): ReactNode {
  return (
    <div className="flex flex-col gap-1 border-b border-line px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{line.name}</p>
          {line.modifiers.length > 0 ? (
            <p className="truncate text-xs text-ink-muted">
              {line.modifiers.map((m) => m.name).join(', ')}
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm tabular-nums text-ink">{line.lineSubtotal}</p>
          {line.qty > 1 ? (
            <p className="text-xs tabular-nums text-ink-muted">{line.unitPrice} each</p>
          ) : null}
        </div>
      </div>

      {/* Item discounts render as credits under the line they reduce. */}
      {line.discounts.map((d) => (
        <div key={d.id} className="flex items-baseline justify-between gap-3 pl-1">
          <span className="text-xs text-emerald-600">{d.label}</span>
          <span className="text-xs tabular-nums text-emerald-600">{d.amount}</span>
        </div>
      ))}

      <div className="mt-1 flex items-center gap-2">
        {canEditItems ? (
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              className="h-9 w-9 px-0 text-base"
              disabled={busy}
              aria-label="Decrease quantity"
              onClick={() => onChangeQty(line.qty - 1)}
            >
              −
            </Button>
            <span className="min-w-[2ch] text-center text-sm tabular-nums text-ink">{line.qty}</span>
            <Button
              variant="secondary"
              className="h-9 w-9 px-0 text-base"
              disabled={busy}
              aria-label="Increase quantity"
              onClick={() => onChangeQty(line.qty + 1)}
            >
              +
            </Button>
          </div>
        ) : (
          <span className="text-sm tabular-nums text-ink-muted">×{line.qty}</span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {canDiscount ? (
            <Button
              variant="ghost"
              className="h-9 px-2 text-xs"
              disabled={busy}
              onClick={onDiscount}
            >
              Discount
            </Button>
          ) : null}
          {canEditItems ? (
            <Button
              variant="ghost"
              className="h-9 px-2 text-xs text-danger"
              disabled={busy}
              onClick={onRemove}
            >
              Remove
            </Button>
          ) : canVoidItem ? (
            <Button
              variant="ghost"
              className="h-9 px-2 text-xs text-danger"
              disabled={busy}
              onClick={onVoid}
            >
              Void
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
