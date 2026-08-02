/**
 * BillCard — one bill in the settlement screen (design §7, S5-08).
 *
 * Shows the bill's label, its total and server-derived tendered/remaining, and
 * the list of tenders taken. An OPEN bill hosts the `TenderForm`; a PAID bill
 * shows a settled badge and, when the session holds PAYMENT_REFUND and a positive
 * tender exists, a refund action. It renders only server-computed money
 * (standard #2) — every amount here traces to a value the API returned.
 */

import type { ReactNode } from 'react'
import { minorToInput } from '../../lib/money-input.ts'
import { billLabel, canRefund } from '../../lib/payment-view.ts'
import type { Bill, PaymentMethod } from '../../lib/types.ts'
import { Badge, Button } from '../../ui/primitives.tsx'
import { TenderForm } from './TenderForm.tsx'

function methodName(methods: PaymentMethod[], id: string): string {
  return methods.find((m) => m.id === id)?.name ?? 'Payment'
}

export function BillCard({
  bill,
  methods,
  busy,
  canRefundPerm,
  onTender,
  onRefund,
}: {
  bill: Bill
  methods: PaymentMethod[]
  busy: boolean
  canRefundPerm: boolean
  onTender: (input: { methodId: string; amountMinor: string; refNo?: string }) => void
  onRefund: () => void
}): ReactNode {
  const settled = bill.status === 'PAID'

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">{billLabel(bill)}</h3>
        {settled ? (
          <Badge tone="active">Paid</Badge>
        ) : (
          <Badge tone="muted">Open</Badge>
        )}
      </header>

      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-ink-muted">Total</dt>
          <dd className="font-medium text-ink">{minorToInput(bill.total)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Tendered</dt>
          <dd className="font-medium text-ink">{minorToInput(bill.tendered)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Remaining</dt>
          <dd className={`font-semibold ${bill.remaining === '0' ? 'text-ink-muted' : 'text-brand'}`}>
            {minorToInput(bill.remaining)}
          </dd>
        </div>
      </dl>

      {bill.payments.length > 0 ? (
        <ul className="flex flex-col gap-1 border-t border-line pt-2 text-sm">
          {bill.payments.map((p) => {
            const refund = p.amount.trim().startsWith('-')
            return (
              <li key={p.id} className="flex items-center justify-between">
                <span className="text-ink-muted">
                  {methodName(methods, p.methodId)}
                  {refund ? ' · refund' : ''}
                  {p.refNo ? ` · ${p.refNo}` : ''}
                </span>
                <span className={refund ? 'text-danger' : 'text-ink'}>{minorToInput(p.amount)}</span>
              </li>
            )
          })}
        </ul>
      ) : null}

      {!settled ? (
        <div className="border-t border-line pt-3">
          <TenderForm bill={bill} methods={methods} busy={busy} onSubmit={onTender} />
        </div>
      ) : canRefundPerm && canRefund(bill) ? (
        <div className="border-t border-line pt-3">
          <Button
            variant="ghost"
            className="h-9 text-xs text-danger"
            disabled={busy}
            onClick={onRefund}
          >
            Issue refund
          </Button>
        </div>
      ) : null}
    </div>
  )
}
