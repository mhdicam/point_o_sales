/**
 * Purchase-order detail — S6-09, design §4.5. A modal over one PO: its lines,
 * the server-derived money summary (frozen at APPROVED, standard #7), and the
 * lifecycle actions legal for the current status. Actions are permission-gated
 * on the UX side (standard #5); the backend is the real boundary and the state
 * machine rejects any illegal transition regardless.
 *
 * The receive flow is inline: while APPROVED/RECEIVING each line shows its
 * outstanding qty and an input for how much arrived now. Over-receipt is blocked
 * client-side for a fast error, but the server re-validates.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { PERMISSIONS, formatMoney } from '@brewsync/shared'
import { usePurchaseOrdersStore, type ReceiveLineInput } from '../../stores/purchase-orders.store.ts'
import { usePermission } from '../../hooks/usePermission.ts'
import type { PurchaseOrder } from '../../lib/types.ts'
import { formatScaledQty, parseScaledQty } from '../../lib/scaled.ts'
import { Modal } from '../../ui/Modal.tsx'
import { Badge, Button, Input } from '../../ui/primitives.tsx'

export interface VariantLabel {
  variantId: string
  label: string
  sku: string
}

export function PurchaseOrderDetail({
  po,
  supplierName,
  labelFor,
  onClose,
}: {
  po: PurchaseOrder
  supplierName: string
  labelFor: (variantId: string) => string
  onClose: () => void
}): ReactNode {
  const { submit, approve, cancel, receive, busy } = usePurchaseOrdersStore()
  const canCreate = usePermission(PERMISSIONS.PURCHASE_CREATE)
  const canApprove = usePermission(PERMISSIONS.PURCHASE_APPROVE)
  const canReceive = usePermission(PERMISSIONS.PURCHASE_RECEIVE)

  // A partial-receipt draft: poItemId → the qty typed for this receipt.
  const [receiving, setReceiving] = useState(false)
  const [qtyByLine, setQtyByLine] = useState<Record<string, string>>({})
  const [actionError, setActionError] = useState<string | null>(null)

  const receivable = po.status === 'APPROVED' || po.status === 'RECEIVING'
  const summary = po.summary ?? {
    subtotal: po.subtotal,
    taxAmount: po.taxAmount,
    total: po.total,
  }

  const outstanding = useMemo(() => {
    const map = new Map<string, bigint>()
    for (const item of po.items) {
      map.set(item.id, BigInt(item.qtyOrderedScaled) - BigInt(item.qtyReceivedScaled))
    }
    return map
  }, [po.items])

  const runAction = async (fn: () => Promise<unknown>): Promise<void> => {
    setActionError(null)
    try {
      await fn()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed.')
    }
  }

  const onCancel = (): void => {
    const reason = window.prompt('Reason for cancelling this purchase order?')
    if (reason === null) return
    void runAction(() => cancel(po.id, reason))
  }

  const submitReceipt = async (): Promise<void> => {
    setActionError(null)
    const lines: ReceiveLineInput[] = []
    try {
      for (const item of po.items) {
        const raw = qtyByLine[item.id]?.trim()
        if (!raw) continue
        const qty = parseScaledQty(raw)
        if (qty === 0n) continue
        const out = outstanding.get(item.id) ?? 0n
        if (qty > out) {
          throw new Error(
            `Line ${labelFor(item.variantId)}: ${formatScaledQty(qty)} exceeds outstanding ${formatScaledQty(out)}.`
          )
        }
        lines.push({ poItemId: item.id, qtyScaled: qty.toString() })
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Invalid receipt.')
      return
    }
    if (lines.length === 0) {
      setActionError('Enter a received quantity on at least one line.')
      return
    }
    try {
      await receive(po.id, lines)
      setReceiving(false)
      setQtyByLine({})
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to receive goods.')
    }
  }

  const footer = (
    <>
      {po.status === 'DRAFT' && canCreate ? (
        <Button variant="danger" onClick={onCancel} disabled={busy} className="mr-auto">
          Cancel PO
        </Button>
      ) : null}
      {(po.status === 'SUBMITTED' || po.status === 'APPROVED') && canApprove ? (
        <Button variant="ghost" onClick={onCancel} disabled={busy} className="mr-auto">
          Cancel PO
        </Button>
      ) : null}

      <Button variant="ghost" onClick={onClose} disabled={busy}>
        Close
      </Button>

      {po.status === 'DRAFT' && canCreate ? (
        <Button onClick={() => void runAction(() => submit(po.id))} disabled={busy}>
          Submit
        </Button>
      ) : null}
      {po.status === 'SUBMITTED' && canApprove ? (
        <Button onClick={() => void runAction(() => approve(po.id))} disabled={busy}>
          Approve
        </Button>
      ) : null}
      {receivable && canReceive && !receiving ? (
        <Button onClick={() => setReceiving(true)} disabled={busy}>
          Receive goods
        </Button>
      ) : null}
      {receiving ? (
        <Button onClick={() => void submitReceipt()} disabled={busy}>
          {busy ? 'Receiving…' : 'Confirm receipt'}
        </Button>
      ) : null}
    </>
  )

  return (
    <Modal title={`PO #${po.poNumber} — ${supplierName}`} onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Badge tone="neutral">{po.status}</Badge>
          {po.taxRateBp > 0 ? (
            <span className="text-xs text-ink-muted">Tax {(po.taxRateBp / 100).toFixed(2)}%</span>
          ) : null}
          {po.expectedDate ? (
            <span className="text-xs text-ink-muted">
              Expected {po.expectedDate.slice(0, 10)}
            </span>
          ) : null}
        </div>

        {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
        {po.cancelReason ? (
          <p className="text-sm text-danger">Cancelled: {po.cancelReason}</p>
        ) : null}

        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-muted">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Ordered</th>
                <th className="px-3 py-2 text-right font-medium">Received</th>
                <th className="px-3 py-2 text-right font-medium">Unit cost</th>
                <th className="px-3 py-2 text-right font-medium">Line</th>
                {receiving ? <th className="px-3 py-2 text-right font-medium">Receive</th> : null}
              </tr>
            </thead>
            <tbody>
              {po.items.map((item) => {
                const out = outstanding.get(item.id) ?? 0n
                return (
                  <tr key={item.id} className="border-b border-line last:border-b-0">
                    <td className="px-3 py-2 text-ink">{labelFor(item.variantId)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">
                      {formatScaledQty(item.qtyOrderedScaled)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-muted">
                      {formatScaledQty(item.qtyReceivedScaled)}
                      {out > 0n && po.status !== 'DRAFT' ? (
                        <span className="ml-1 text-xs text-brand">
                          ({formatScaledQty(out)} left)
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-muted">
                      {formatMoney(BigInt(item.unitCost))}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">
                      {formatMoney(BigInt(po.status === 'DRAFT' ? item.lineTotalPreview : item.lineTotal))}
                    </td>
                    {receiving ? (
                      <td className="px-3 py-2 text-right">
                        <Input
                          value={qtyByLine[item.id] ?? ''}
                          onChange={(e) =>
                            setQtyByLine((prev) => ({ ...prev, [item.id]: e.target.value }))
                          }
                          inputMode="decimal"
                          placeholder={out > 0n ? formatScaledQty(out) : '0'}
                          disabled={out === 0n}
                          className="w-24 text-right"
                        />
                      </td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <dl className="ml-auto w-full max-w-xs text-sm">
          <Row label="Subtotal" value={formatMoney(BigInt(summary.subtotal))} />
          <Row label="Tax" value={formatMoney(BigInt(summary.taxAmount))} />
          <Row label="Total" value={formatMoney(BigInt(summary.total))} strong />
        </dl>

        {po.notes ? <p className="text-xs text-ink-muted">Notes: {po.notes}</p> : null}
      </div>
    </Modal>
  )
}

function Row({
  label,
  value,
  strong,
}: {
  label: string
  value: string
  strong?: boolean
}): ReactNode {
  return (
    <div className="flex items-center justify-between py-1">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={`tabular-nums ${strong ? 'text-base font-semibold text-ink' : 'text-ink'}`}>
        {value}
      </dd>
    </div>
  )
}
