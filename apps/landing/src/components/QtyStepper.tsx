import type { ReactNode } from 'react'

/**
 * A thumb-friendly −/＋ stepper (design §19: tap targets ≥44px). At qty 0 it
 * collapses to a single "Tambah" button so the menu row stays uncluttered until
 * the item is in the cart.
 */
export function QtyStepper({
  qty,
  onChange,
  label,
}: {
  qty: number
  onChange: (next: number) => void
  /** Accessible name for the add button, e.g. the item name. */
  label: string
}): ReactNode {
  if (qty <= 0) {
    return (
      <button
        type="button"
        onClick={() => onChange(1)}
        aria-label={`Tambah ${label}`}
        className="min-h-tap min-w-tap rounded-full bg-brand px-4 font-medium text-white active:scale-95"
      >
        Tambah
      </button>
    )
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => onChange(qty - 1)}
        aria-label={`Kurangi ${label}`}
        className="flex min-h-tap min-w-tap items-center justify-center rounded-full border border-line text-xl active:scale-95"
      >
        −
      </button>
      <span aria-live="polite" className="w-6 text-center font-semibold tabular-nums">
        {qty}
      </span>
      <button
        type="button"
        onClick={() => onChange(qty + 1)}
        aria-label={`Tambah ${label}`}
        className="flex min-h-tap min-w-tap items-center justify-center rounded-full bg-brand text-xl text-white active:scale-95"
      >
        ＋
      </button>
    </div>
  )
}
