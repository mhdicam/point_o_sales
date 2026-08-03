/**
 * Create-PO modal — S6-09, design §4.5. Drafts a new purchase order: supplier,
 * optional expected date + tax rate, and one or more lines (variant, ordered qty,
 * unit cost). It only ever creates a DRAFT — submit/approve/receive happen from
 * the detail view. Quantities and costs are parsed into scaled/minor-unit strings
 * for the wire (standard #2); the server owns all money math and the poNumber.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  usePurchaseOrdersStore,
  type PurchaseOrderLineInput,
} from '../../stores/purchase-orders.store.ts'
import type { Supplier } from '../../lib/types.ts'
import { parseScaledQty, parseMinorUnits, parseTaxRateBp } from '../../lib/scaled.ts'
import type { VariantLabel } from './PurchaseOrderDetail.tsx'
import { Modal } from '../../ui/Modal.tsx'
import { Button, Field, Input, Select } from '../../ui/primitives.tsx'

/** One editable draft line in the form (raw strings until submit). */
interface DraftLine {
  key: number
  variantId: string
  qty: string
  unitCost: string
}

let nextKey = 1
const blankLine = (variantId: string): DraftLine => ({
  key: nextKey++,
  variantId,
  qty: '',
  unitCost: '',
})

export function CreatePurchaseOrderModal({
  outletId,
  suppliers,
  variants,
  onClose,
}: {
  outletId: string
  suppliers: Supplier[]
  variants: VariantLabel[]
  onClose: () => void
}): ReactNode {
  const create = usePurchaseOrdersStore((s) => s.create)

  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? '')
  const [expectedDate, setExpectedDate] = useState('')
  const [taxPercent, setTaxPercent] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([blankLine(variants[0]?.variantId ?? '')])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const setLine = (key: number, patch: Partial<DraftLine>): void =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const addLine = (): void => setLines((prev) => [...prev, blankLine(variants[0]?.variantId ?? '')])
  const removeLine = (key: number): void =>
    setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev))

  const submit = async (): Promise<void> => {
    setError(null)
    if (!supplierId) {
      setError('Pick a supplier.')
      return
    }
    let taxRateBp = 0
    if (taxPercent.trim()) {
      try {
        taxRateBp = parseTaxRateBp(taxPercent)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid tax rate.')
        return
      }
    }

    const items: PurchaseOrderLineInput[] = []
    try {
      for (const line of lines) {
        if (!line.qty.trim() && !line.unitCost.trim()) continue
        if (!line.variantId) throw new Error('Every line needs an item.')
        const qtyScaled = parseScaledQty(line.qty)
        if (qtyScaled === 0n) throw new Error('Line quantity must be greater than zero.')
        const item: PurchaseOrderLineInput = {
          variantId: line.variantId,
          qtyOrderedScaled: qtyScaled.toString(),
        }
        if (line.unitCost.trim()) item.unitCost = parseMinorUnits(line.unitCost).toString()
        items.push(item)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid line.')
      return
    }
    if (items.length === 0) {
      setError('Add at least one line with a quantity.')
      return
    }

    setBusy(true)
    try {
      await create({
        outletId,
        supplierId,
        taxRateBp,
        ...(expectedDate ? { expectedDate } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        items,
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create purchase order.')
      setBusy(false)
    }
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button onClick={submit} disabled={busy}>
        {busy ? 'Creating…' : 'Create draft'}
      </Button>
    </>
  )

  return (
    <Modal title="New purchase order" onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">
        {error ? <p className="text-sm text-danger">{error}</p> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Supplier">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              {suppliers.length === 0 ? <option value="">No active suppliers</option> : null}
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Expected date">
            <Input
              type="date"
              value={expectedDate}
              onChange={(e) => setExpectedDate(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Tax rate (%)">
          <Input
            value={taxPercent}
            onChange={(e) => setTaxPercent(e.target.value)}
            inputMode="decimal"
            placeholder="e.g. 11"
            className="max-w-[8rem]"
          />
        </Field>

        <Field label="Notes">
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional"
          />
        </Field>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Lines</span>
            <Button variant="ghost" onClick={addLine} className="h-9 px-3 text-xs">
              + Add line
            </Button>
          </div>
          {lines.map((line) => (
            <div key={line.key} className="grid grid-cols-[1fr,5rem,6rem,auto] items-end gap-2">
              <Field label="Item">
                <Select
                  value={line.variantId}
                  onChange={(e) => setLine(line.key, { variantId: e.target.value })}
                >
                  {variants.length === 0 ? <option value="">No items</option> : null}
                  {variants.map((v) => (
                    <option key={v.variantId} value={v.variantId}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Qty">
                <Input
                  value={line.qty}
                  onChange={(e) => setLine(line.key, { qty: e.target.value })}
                  inputMode="decimal"
                  placeholder="0"
                />
              </Field>
              <Field label="Unit cost">
                <Input
                  value={line.unitCost}
                  onChange={(e) => setLine(line.key, { unitCost: e.target.value })}
                  inputMode="numeric"
                  placeholder="0"
                />
              </Field>
              <button
                type="button"
                onClick={() => removeLine(line.key)}
                disabled={lines.length === 1}
                className="min-h-tap px-2 text-ink-muted hover:text-danger disabled:opacity-30"
                aria-label="Remove line"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
