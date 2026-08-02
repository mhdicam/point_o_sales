/**
 * TenderForm — takes one payment against an open bill (design §7.1/§7.2, S5-08).
 *
 * A method picker, an amount field (defaulting to what remains due), and a
 * reference field that appears only when the chosen method needs one. It computes
 * no money (standard #2): it converts the typed major amount to minor units at
 * the edge and hands it to the store; the server validates the tender, records
 * the change, and returns the new balance. Quick-cash chips fill the amount for
 * the common exact/round-up tenders.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { inputToMinor, minorToInput } from '../../lib/money-input.ts'
import type { Bill, PaymentMethod } from '../../lib/types.ts'
import { Button, Field, Input, Select } from '../../ui/primitives.tsx'

/** Round a remaining-due minor string up to the next 5000/10000/50000 note. */
function roundUpNotes(remainingMinor: string): string[] {
  const due = BigInt(remainingMinor || '0')
  const notes = [500000n, 1000000n, 5000000n] // 5k / 10k / 50k in 2-dp minor units
  const out: string[] = []
  for (const note of notes) {
    const up = ((due + note - 1n) / note) * note
    if (up > due && !out.includes(up.toString())) out.push(up.toString())
    if (out.length >= 2) break
  }
  return out
}

export function TenderForm({
  bill,
  methods,
  busy,
  onSubmit,
}: {
  bill: Bill
  methods: PaymentMethod[]
  busy: boolean
  onSubmit: (input: { methodId: string; amountMinor: string; refNo?: string }) => void
}): ReactNode {
  const active = useMemo(() => methods.filter((m) => m.isActive), [methods])
  const [methodId, setMethodId] = useState(() => {
    const cash = active.find((m) => m.countsAsCash)
    return (cash ?? active[0])?.id ?? ''
  })
  const [amount, setAmount] = useState(() => minorToInput(bill.remaining))
  const [refNo, setRefNo] = useState('')
  const [error, setError] = useState<string | null>(null)

  const method = active.find((m) => m.id === methodId) ?? null
  const quickCash = method?.countsAsCash ? roundUpNotes(bill.remaining) : []

  const submit = (): void => {
    if (!method) {
      setError('Choose a payment method.')
      return
    }
    const minor = inputToMinor(amount)
    if (minor === null || minor.startsWith('-') || minor === '0') {
      setError('Enter a valid tender amount.')
      return
    }
    if (method.needsRefNo && refNo.trim() === '') {
      setError(`${method.name} needs a reference number.`)
      return
    }
    setError(null)
    onSubmit({ methodId: method.id, amountMinor: minor, ...(refNo.trim() ? { refNo: refNo.trim() } : {}) })
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="Method">
        <Select value={methodId} onChange={(e) => setMethodId(e.target.value)} disabled={busy}>
          {active.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Amount tendered">
        <Input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={minorToInput(bill.remaining)}
          disabled={busy}
        />
      </Field>

      {quickCash.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            className="h-9 px-3 text-xs"
            disabled={busy}
            onClick={() => setAmount(minorToInput(bill.remaining))}
          >
            Exact {minorToInput(bill.remaining)}
          </Button>
          {quickCash.map((c) => (
            <Button
              key={c}
              type="button"
              variant="secondary"
              className="h-9 px-3 text-xs"
              disabled={busy}
              onClick={() => setAmount(minorToInput(c))}
            >
              {minorToInput(c)}
            </Button>
          ))}
        </div>
      ) : null}

      {method?.needsRefNo ? (
        <Field label="Reference">
          <Input
            type="text"
            value={refNo}
            onChange={(e) => setRefNo(e.target.value)}
            placeholder="Approval / txn id"
            disabled={busy}
          />
        </Field>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <Button onClick={submit} disabled={busy}>
        Take payment
      </Button>
    </div>
  )
}
