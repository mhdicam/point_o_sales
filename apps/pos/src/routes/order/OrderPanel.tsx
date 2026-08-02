/**
 * OrderPanel — the running order: line list, money breakdown, and the lifecycle
 * action bar (design §6/§7, S4-08).
 *
 * Renders the `OrderView` the parent derived and forwards intents up; it holds no
 * server state and does no money math. Every control is the AND of a status-legal
 * flag (`view.actions`, from the state machine) and a permission the parent
 * passed in (standard #5) — the panel only shows what it was handed a callback and
 * a `true` gate for. The backend re-checks both regardless.
 */

import type { ReactNode } from 'react'
import type { OrderView } from '../../lib/order-view.ts'
import { Button, EmptyState } from '../../ui/primitives.tsx'
import { OrderLineRow } from './OrderLineRow.tsx'
import { ChargeBreakdown } from './ChargeBreakdown.tsx'

export interface OrderPanelPermissions {
  edit: boolean
  send: boolean
  voidItem: boolean
  voidOrder: boolean
  discount: boolean
  pay: boolean
}

export function OrderPanel({
  view,
  perms,
  busy,
  onChangeQty,
  onRemove,
  onVoidItem,
  onItemDiscount,
  onOrderDiscount,
  onGratuity,
  onSend,
  onServe,
  onBill,
  onPay,
  onVoidOrder,
}: {
  view: OrderView
  perms: OrderPanelPermissions
  busy: boolean
  onChangeQty: (itemId: string, qty: number) => void
  onRemove: (itemId: string) => void
  onVoidItem: (itemId: string) => void
  onItemDiscount: (itemId: string) => void
  onOrderDiscount: () => void
  onGratuity: () => void
  onSend: () => void
  onServe: () => void
  onBill: () => void
  onPay: () => void
  onVoidOrder: () => void
}): ReactNode {
  const a = view.actions
  const canEditItems = a.editItems && perms.edit
  const canVoidItem = a.voidItem && perms.voidItem
  const canDiscount = a.discount && perms.discount

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Order</h2>
        <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-ink-muted">
          {view.statusLabel}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {view.isEmpty ? (
          <EmptyState title="No items yet" hint="Tap a product to start the order." />
        ) : (
          view.lines.map((line) => (
            <OrderLineRow
              key={line.id}
              line={line}
              canEditItems={canEditItems}
              canVoidItem={canVoidItem}
              canDiscount={canDiscount}
              busy={busy}
              onChangeQty={(qty) => onChangeQty(line.id, qty)}
              onRemove={() => onRemove(line.id)}
              onVoid={() => onVoidItem(line.id)}
              onDiscount={() => onItemDiscount(line.id)}
            />
          ))
        )}
      </div>

      {!view.isEmpty ? <ChargeBreakdown view={view} /> : null}

      {/* Order-level secondary actions. */}
      {!view.isEmpty && (canDiscount || a.discount) ? (
        <div className="flex gap-2 border-t border-line px-4 py-2">
          {canDiscount ? (
            <Button variant="ghost" className="h-9 flex-1 px-2 text-xs" disabled={busy} onClick={onOrderDiscount}>
              Order discount
            </Button>
          ) : null}
          {canDiscount ? (
            <Button variant="ghost" className="h-9 flex-1 px-2 text-xs" disabled={busy} onClick={onGratuity}>
              Gratuity
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Primary lifecycle bar. */}
      <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
        <div className="flex gap-2">
          {a.send && perms.send ? (
            <Button className="flex-1" disabled={busy || view.isEmpty} onClick={onSend}>
              Send to kitchen
            </Button>
          ) : null}
          {a.serve ? (
            <Button variant="secondary" className="flex-1" disabled={busy} onClick={onServe}>
              Mark served
            </Button>
          ) : null}
          {a.bill ? (
            <Button className="flex-1" disabled={busy} onClick={onBill}>
              Bill
            </Button>
          ) : null}
          {a.pay && perms.pay ? (
            <Button className="flex-1" disabled={busy} onClick={onPay}>
              Take payment
            </Button>
          ) : null}
        </div>
        {a.voidOrder && perms.voidOrder ? (
          <Button variant="ghost" className="h-9 text-xs text-danger" disabled={busy} onClick={onVoidOrder}>
            Void order
          </Button>
        ) : null}
      </div>
    </div>
  )
}
