/**
 * SplitDialog — partitions an order's single bill (design §7.3, S5-08).
 *
 * Two modes: an even N-way split, or explicit per-share weights. It sends the
 * chosen shape to the store, which posts it to `POST /payments/orders/:id/split`;
 * the backend re-partitions via the largest-remainder money helpers so
 * SUM(bill.total) === order total holds exactly (standard #2) — this dialog never
 * computes the shares itself. Weights are entered as plain numbers (seat counts
 * or major-unit shares); they cross the wire as minor-unit decimal strings.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { inputToMinor } from '../../lib/money-input.ts'
import type { SplitBillInput } from '../../lib/types.ts'
import { Button, Field, Input, Select } from '../../ui/primitives.tsx'
import { Modal } from '../../ui/Modal.tsx'

type Mode = 'even' | 'weights'

export function SplitDialog({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean
  onClose: () => void
  onSubmit: (input: SplitBillInput) => void
}): ReactNode {
  const [mode, setMode] = useState<Mode>('even')
  const [parts, setParts] = useState('2')
  const [weightsText, setWeightsText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    if (mode === 'even') {
      const n = Number.parseInt(parts, 10)
      if (!Number.isInteger(n) || n < 2 || n > 50) {
        setError('Enter a number of ways between 2 and 50.')
        return
      }
      onSubmit({ mode: 'even', parts: n })
      return
    }
    const rawParts = weightsText
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
    if (rawParts.length < 2) {
      setError('Enter at least two shares, comma-separated.')
      return
    }
    const weights: string[] = []
    for (const raw of rawParts) {
      const minor = inputToMinor(raw)
      if (minor === null || minor.startsWith('-')) {
        setError(`"${raw}" is not a valid share.`)
        return
      }
      weights.push(minor)
    }
    onSubmit({ mode: 'weights', weights })
  }

  return (
    <Modal
      title="Split bill"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            Split
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Mode">
          <Select value={mode} onChange={(e) => setMode(e.target.value as Mode)} disabled={busy}>
            <option value="even">Even — split N ways</option>
            <option value="weights">By share — enter each amount</option>
          </Select>
        </Field>

        {mode === 'even' ? (
          <Field label="Number of ways">
            <Input
              type="number"
              min={2}
              max={50}
              value={parts}
              onChange={(e) => setParts(e.target.value)}
              disabled={busy}
              autoFocus
            />
          </Field>
        ) : (
          <Field label="Shares (comma-separated)">
            <Input
              type="text"
              inputMode="decimal"
              value={weightsText}
              onChange={(e) => setWeightsText(e.target.value)}
              placeholder="50.00, 30.00, 20.00"
              disabled={busy}
              autoFocus
            />
          </Field>
        )}

        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <p className="text-xs text-ink-muted">
          Shares are relative weights — the server allocates the exact total across them so the split
          always sums to the order total.
        </p>
      </div>
    </Modal>
  )
}
