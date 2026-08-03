/**
 * RefundDialog — returns money on a settled bill (design §7.4, S5-08).
 *
 * A refund is a negative Payment carrying a reason — never a delete (standard
 * #3). This dialog collects the amount (defaulting to what was collected), the
 * tender it is returned on, and the mandatory reason, then hands them to the
 * store. The backend caps the amount at what was actually collected and records
 * the negative row plus a `RefundIssued` event; this dialog computes no money.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { inputToMinor, minorToInput } from '../../lib/money-input.ts'
import type { Bill, PaymentMethod } from '../../lib/types.ts'
import { Button, Field, Input, Select, Textarea } from '../../ui/primitives.tsx'
import { Modal } from '../../ui/Modal.tsx'

export function RefundDialog({
  bill,
  methods,
  busy,
  onClose,
  onSubmit,
}: {
  bill: Bill
  methods: PaymentMethod[]
  busy: boolean
  onClose: () => void
  onSubmit: (input: { methodId: string; amountMinor: string; reason: string; refNo?: string }) => void
}): ReactNode {
  const active = useMemo(() => methods.filter((m) => m.isActive), [methods])
  const [methodId, setMethodId] = useState(() => active[0]?.id ?? '')
  const [amount, setAmount] = useState(() => minorToInput(bill.tendered))
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    if (methodId === '') {
      setError('Choose a tender to refund on.')
      return
    }
    const minor = inputToMinor(amount)
    if (minor === null || minor.startsWith('-') || minor === '0') {
      setError('Enter a valid refund amount.')
      return
    }
    if (reason.trim() === '') {
      setError('A refund requires a reason.')
      return
    }
    onSubmit({ methodId, amountMinor: minor, reason: reason.trim() })
  }

  return (
    <Modal
      title="Issue refund"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={submit} disabled={busy}>
            Refund
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          Collected on this bill: <span className="font-medium text-ink">{minorToInput(bill.tendered)}</span>
        </p>
        <Field label="Refund method">
          <Select value={methodId} onChange={(e) => setMethodId(e.target.value)} disabled={busy}>
            {active.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount">
          <Input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label="Reason">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being refunded?"
            disabled={busy}
          />
        </Field>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Modal>
  )
}
