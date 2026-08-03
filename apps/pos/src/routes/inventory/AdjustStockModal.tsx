/**
 * Stock-opname / manual-correction modal — S6-09, design §4.1. Posts one signed
 * ADJUSTMENT/WASTE/TRANSFER/PRODUCTION movement (never overwrites a balance —
 * there is no balance, standard #3). A stock take is entered as the *delta* to
 * apply, positive or negative. ADJUSTMENT and WASTE require a reason (the backend
 * enforces this too). Quantity is the variant's stock unit; cost is optional
 * minor units per base unit.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  useInventoryStore,
  type AdjustInput,
  type ManualStockMovementType,
} from '../../stores/inventory.store.ts'
import { parseScaledQty, parseMinorUnits } from '../../lib/scaled.ts'
import type { VariantLabel } from '../InventoryScreen.tsx'
import { Modal } from '../../ui/Modal.tsx'
import { Button, Field, Input, Select, Textarea } from '../../ui/primitives.tsx'

const TYPES: { value: ManualStockMovementType; label: string; hint: string }[] = [
  { value: 'ADJUSTMENT', label: 'Adjustment (stock opname)', hint: 'Signed correction to on-hand.' },
  { value: 'WASTE', label: 'Waste / spoilage', hint: 'Enter a negative quantity.' },
  { value: 'PRODUCTION', label: 'Production', hint: 'Stock produced in-house.' },
  { value: 'TRANSFER', label: 'Transfer', hint: 'Signed transfer in/out.' },
]

export function AdjustStockModal({
  variants,
  onClose,
}: {
  variants: VariantLabel[]
  onClose: () => void
}): ReactNode {
  const adjust = useInventoryStore((s) => s.adjust)

  const [variantId, setVariantId] = useState(variants[0]?.variantId ?? '')
  const [type, setType] = useState<ManualStockMovementType>('ADJUSTMENT')
  const [sign, setSign] = useState<'+' | '-'>('+')
  const [qty, setQty] = useState('')
  const [cost, setCost] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const needsReason = type === 'ADJUSTMENT' || type === 'WASTE'
  const activeType = TYPES.find((t) => t.value === type)

  const submit = async (): Promise<void> => {
    setError(null)
    if (!variantId) {
      setError('Pick an item.')
      return
    }
    let qtyScaled: bigint
    try {
      const magnitude = parseScaledQty(qty)
      if (magnitude === 0n) throw new Error('Quantity cannot be zero.')
      qtyScaled = sign === '-' ? -magnitude : magnitude
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid quantity.')
      return
    }
    let costPerUnit: bigint | null = null
    if (cost.trim()) {
      try {
        costPerUnit = parseMinorUnits(cost)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid cost.')
        return
      }
    }
    if (needsReason && !reason.trim()) {
      setError('A reason is required for an adjustment or waste.')
      return
    }

    const input: AdjustInput = {
      variantId,
      qtyScaled,
      type,
      ...(costPerUnit != null ? { costPerUnit } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    }
    setBusy(true)
    try {
      await adjust(input)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to record adjustment.')
      setBusy(false)
    }
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button onClick={submit} disabled={busy}>
        {busy ? 'Recording…' : 'Record'}
      </Button>
    </>
  )

  return (
    <Modal title="Stock opname" onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <Field label="Item">
          <Select value={variantId} onChange={(e) => setVariantId(e.target.value)}>
            {variants.length === 0 ? <option value="">No items</option> : null}
            {variants.map((v) => (
              <option key={v.variantId} value={v.variantId}>
                {v.label} ({v.sku})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Type">
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as ManualStockMovementType)}
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
          {activeType ? <span className="text-xs text-ink-muted">{activeType.hint}</span> : null}
        </Field>
        <div className="grid grid-cols-[auto,1fr] gap-2">
          <Field label="Direction">
            <Select value={sign} onChange={(e) => setSign(e.target.value as '+' | '-')}>
              <option value="+">+ Add</option>
              <option value="-">− Remove</option>
            </Select>
          </Field>
          <Field label="Quantity (stock unit)">
            <Input
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </Field>
        </div>
        <Field label="Cost per base unit (optional, minor units)">
          <Input
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            inputMode="numeric"
            placeholder="e.g. 12000"
          />
        </Field>
        <Field label={needsReason ? 'Reason (required)' : 'Reason (optional)'}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  )
}
