/**
 * ChargeBreakdown — the money summary under the line list (design §6.2).
 *
 * Renders the order-level `OrderCharge` rows the pipeline produced, in the order
 * the server sorted them (order discount → service charge → tax → rounding), then
 * the subtotal/total, then gratuity outside the total (§6 step 7). It does no
 * arithmetic: every figure is a formatted string from `buildOrderView`, which
 * only reformats what the backend computed (standard #2). Currency prefix is
 * cosmetic; the amount itself is the authoritative value.
 */

import type { ReactNode } from 'react'
import type { ChargeLineView, OrderView } from '../../lib/order-view.ts'

function Row({
  label,
  amount,
  isCredit = false,
  strong = false,
  muted = false,
}: {
  label: string
  amount: string
  isCredit?: boolean
  strong?: boolean
  muted?: boolean
}): ReactNode {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${strong ? 'text-base font-semibold text-ink' : 'text-sm'}`}>
      <span className={muted ? 'text-ink-muted' : strong ? 'text-ink' : 'text-ink-muted'}>{label}</span>
      <span
        className={`tabular-nums ${
          isCredit ? 'text-emerald-600' : strong ? 'text-ink' : 'text-ink'
        }`}
      >
        {isCredit ? '' : ''}
        {amount}
      </span>
    </div>
  )
}

function chargeRow(c: ChargeLineView): ReactNode {
  // A tax row in inclusive mode is a memo (already inside the subtotal); we still
  // show it, labelled by the server, but it reads as informational.
  return <Row key={c.id} label={c.label} amount={c.amount} isCredit={c.isCredit} />
}

export function ChargeBreakdown({ view }: { view: OrderView }): ReactNode {
  return (
    <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
      <Row label="Subtotal" amount={view.subtotal} muted />
      {view.breakdown.map(chargeRow)}
      <div className="mt-1 border-t border-line pt-2">
        <Row label="Total" amount={view.total} strong />
      </div>
      {view.gratuity ? (
        <Row label={view.gratuity.label} amount={view.gratuity.amount} muted />
      ) : null}
      {view.gratuity ? <Row label="Amount due" amount={view.amountDue} strong /> : null}
    </div>
  )
}
