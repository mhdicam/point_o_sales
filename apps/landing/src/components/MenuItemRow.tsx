import type { ReactNode } from 'react'
import type { QrMenuVariant } from '../lib/qr-types.ts'
import { MoneyText } from './MoneyText.tsx'
import { QtyStepper } from './QtyStepper.tsx'

/**
 * One purchasable variant row in the menu list. Single-column, price on the
 * left, stepper on the right (design §19 thumb-friendly). The variant name is
 * shown only when the product has more than one (the caller passes
 * `showVariantName`), so a single-variant product reads as just its product name.
 */
export function MenuItemRow({
  variant,
  showVariantName,
  qty,
  onQty,
}: {
  variant: QrMenuVariant
  showVariantName: boolean
  qty: number
  onQty: (next: number) => void
}): ReactNode {
  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        {showVariantName && <div className="truncate text-ink">{variant.name}</div>}
        <div className="text-sm text-ink-muted">
          <MoneyText amount={variant.price} />
        </div>
      </div>
      <QtyStepper qty={qty} onChange={onQty} label={variant.name} />
    </li>
  )
}
