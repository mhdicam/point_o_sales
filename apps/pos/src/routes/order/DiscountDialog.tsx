/**
 * DiscountDialog — collects a percent OR fixed-amount discount (design §6.4),
 * used for both item- and order-scoped discounts (the caller decides the target).
 *
 * Mirrors the backend `discountSchema`: exactly one of a percent or a fixed
 * amount. The percent is entered as a human number and converted to basis points
 * (10 → 1000 bp); the fixed amount is converted to minor units via `inputToMinor`.
 * The conversion is a boundary concern (form → wire), not money math — the bill
 * pipeline applies the discount and does the one rounding (standard #2).
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '../../ui/Modal.tsx'
import { Button, Field, Input, Select } from '../../ui/primitives.tsx'
import { inputToMinor } from '../../lib/money-input.ts'
import type { DiscountPayload } from '../../stores/orders.store.ts'

type Mode = 'percent' | 'amount'

export function DiscountDialog({
  title,
  busy,
  onClose,
  onSubmit,
}: {
  title: string
  busy: boolean
  onClose: () => void
  onSubmit: (discount: DiscountPayload) => void
}): ReactNode {
  const [mode, setMode] = useState<Mode>('percent')
  const [label, setLabel] = useState('')
  const [percent, setPercent] = useState('')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const trimmedLabel = label.trim()
    if (trimmedLabel === '') {
      setError('A label is required.')
      return
    }

    if (mode === 'percent') {
      // "12.5"% → 1250 bp. Reuse the minor-unit adapter at 2 digits (1% = 100 bp):
      // it scales exactly and rejects finer-than-a-bp input rather than rounding —
      // no ad-hoc float math (standard #2).
      const rateBp = inputToMinor(percent, 2)
      if (rateBp === null || rateBp === '0' || rateBp.startsWith('-') || Number(rateBp) > 10000) {
        setError('Enter a percent between 0 and 100.')
        return
      }
      onSubmit({ label: trimmedLabel, rateBp: Number(rateBp) })
      return
    }

    const minor = inputToMinor(amount, 2)
    if (minor === null || minor === '0' || minor.startsWith('-')) {
      setError('Enter a positive amount.')
      return
    }
    onSubmit({ label: trimmedLabel, amountMinor: minor })
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Label">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Staff discount"
            autoFocus
          />
        </Field>

        <Field label="Type">
          <Select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="percent">Percent (%)</option>
            <option value="amount">Fixed amount</option>
          </Select>
        </Field>

        {mode === 'percent' ? (
          <Field label="Percent">
            <Input
              type="number"
              min="0"
              max="100"
              step="0.01"
              inputMode="decimal"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              placeholder="10"
            />
          </Field>
        ) : (
          <Field label="Amount">
            <Input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="5.00"
            />
          </Field>
        )}

        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Modal>
  )
}
