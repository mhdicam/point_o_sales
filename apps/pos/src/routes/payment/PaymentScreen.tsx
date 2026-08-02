/**
 * PaymentScreen — settle a billed order (design §7, S5-08).
 *
 * Reached from the order screen once an order is BILLED (`/admin/pay/:orderId`).
 * Loads the order, the active tenders, and the order's bills, then:
 *
 *   - lists each bill via `BillCard` (tender on OPEN, refund on PAID);
 *   - offers a split while the order still has one unpaid bill (§7.3);
 *   - surfaces the change to hand back after a settling cash tender;
 *   - shows a completion state once every bill is settled (order → PAID), with a
 *     shortcut back to a fresh order.
 *
 * It does no money math (standard #2): amounts, change, and balances are all
 * server-computed. Every action is the AND of a status-legal flag (payment-view)
 * and a permission (standard #5); the backend re-checks both.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PERMISSIONS } from '@brewsync/shared'
import { minorToInput } from '../../lib/money-input.ts'
import { canSplit, isFullySettled } from '../../lib/payment-view.ts'
import type { SplitBillInput } from '../../lib/types.ts'
import { useOrdersStore } from '../../stores/orders.store.ts'
import { usePaymentsStore } from '../../stores/payments.store.ts'
import { usePermission } from '../../hooks/usePermission.ts'
import { Button, ErrorBanner, Spinner } from '../../ui/primitives.tsx'
import { BillCard } from './BillCard.tsx'
import { SplitDialog } from './SplitDialog.tsx'
import { RefundDialog } from './RefundDialog.tsx'

export function PaymentScreen(): ReactNode {
  const { orderId } = useParams<{ orderId: string }>()
  const navigate = useNavigate()

  const order = useOrdersStore((s) => s.current)
  const getOrder = useOrdersStore((s) => s.getById)
  const clearOrder = useOrdersStore((s) => s.clear)

  const bills = usePaymentsStore((s) => s.bills)
  const methods = usePaymentsStore((s) => s.methods)
  const loading = usePaymentsStore((s) => s.loading)
  const busy = usePaymentsStore((s) => s.busy)
  const error = usePaymentsStore((s) => s.error)
  const {
    loadMethods,
    loadBills,
    split,
    accept,
    refund,
    clear: clearPayments,
  } = usePaymentsStore.getState()

  const canRefundPerm = usePermission(PERMISSIONS.PAYMENT_REFUND)

  const [splitOpen, setSplitOpen] = useState(false)
  const [refundBillId, setRefundBillId] = useState<string | null>(null)
  const [change, setChange] = useState<string | null>(null)

  useEffect(() => {
    if (!orderId) return
    void loadMethods()
    void loadBills(orderId)
    void getOrder(orderId)
    return () => clearPayments()
  }, [orderId, loadMethods, loadBills, getOrder, clearPayments])

  if (!orderId) {
    return (
      <div className="p-6">
        <ErrorBanner message="No order selected for payment." />
      </div>
    )
  }

  const settled = isFullySettled(bills)
  const showSplit = order ? canSplit(order.status, bills) : false
  const refundBill = bills.find((b) => b.id === refundBillId) ?? null

  const onTender = async (
    billId: string,
    input: { methodId: string; amountMinor: string; refNo?: string }
  ): Promise<void> => {
    const changeGiven = await accept(billId, input)
    // Only surface change worth handing back (a positive over-tender).
    setChange(changeGiven && changeGiven !== '0' && !changeGiven.startsWith('-') ? changeGiven : null)
    if (orderId) void getOrder(orderId) // a settling tender may flip the order to PAID
  }

  const onSplit = async (input: SplitBillInput): Promise<void> => {
    setSplitOpen(false)
    await split(orderId, input)
  }

  const onRefund = async (input: {
    methodId: string
    amountMinor: string
    reason: string
    refNo?: string
  }): Promise<void> => {
    const billId = refundBillId
    setRefundBillId(null)
    if (!billId) return
    await refund(billId, input)
    if (orderId) void getOrder(orderId)
  }

  const startNewOrder = (): void => {
    clearOrder()
    navigate('/admin/order')
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Payment</h1>
          {order ? (
            <p className="text-xs text-ink-muted">
              Order due <span className="font-medium text-ink">{minorToInput(order.summary.amountDue)}</span>
            </p>
          ) : null}
        </div>
        <Button variant="ghost" onClick={startNewOrder}>
          New order
        </Button>
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      {change ? (
        <div
          className="motion-safe:animate-pulse rounded-xl border border-brand/30 bg-brand/10 px-4 py-3 text-center"
          role="status"
        >
          <p className="text-xs text-ink-muted">Change to hand back</p>
          <p className="text-2xl font-bold text-brand">{minorToInput(change)}</p>
        </div>
      ) : null}

      {settled ? (
        <div className="rounded-xl border border-line bg-surface p-6 text-center">
          <p className="text-base font-semibold text-ink">Order settled</p>
          <p className="mt-1 text-sm text-ink-muted">Every bill is paid. The sale is complete.</p>
          <Button className="mt-4" onClick={startNewOrder}>
            Start a new order
          </Button>
        </div>
      ) : null}

      {loading && bills.length === 0 ? (
        <Spinner label="Loading bills…" />
      ) : (
        <div className="flex flex-col gap-3">
          {bills.map((bill) => (
            <BillCard
              key={bill.id}
              bill={bill}
              methods={methods}
              busy={busy}
              canRefundPerm={canRefundPerm}
              onTender={(input) => void onTender(bill.id, input)}
              onRefund={() => setRefundBillId(bill.id)}
            />
          ))}
        </div>
      )}

      {showSplit ? (
        <Button variant="secondary" disabled={busy} onClick={() => setSplitOpen(true)}>
          Split bill
        </Button>
      ) : null}

      {splitOpen ? (
        <SplitDialog busy={busy} onClose={() => setSplitOpen(false)} onSubmit={(i) => void onSplit(i)} />
      ) : null}

      {refundBill ? (
        <RefundDialog
          bill={refundBill}
          methods={methods}
          busy={busy}
          onClose={() => setRefundBillId(null)}
          onSubmit={(i) => void onRefund(i)}
        />
      ) : null}
    </div>
  )
}
