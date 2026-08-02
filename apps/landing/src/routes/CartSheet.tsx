import type { ReactNode } from 'react'
import type { CartView } from '../lib/cart-view.ts'

/**
 * The cart as a bottom-sheet (design §19: on a narrow screen the order panel
 * *restructures* into a bottom-sheet, it does not merely shrink). Slides up on
 * `transform` only, honoring `prefers-reduced-motion` via index.css. Renders the
 * cart view-model's line + subtotal previews; the subtotal is explicitly a
 * preview, not the payable total (the server adds tax/charges/rounding at
 * placement — standard #2).
 */
export function CartSheet({
  view,
  placing,
  onQty,
  onCheckout,
  onClose,
}: {
  view: CartView
  placing: boolean
  onQty: (variantId: string, qty: number) => void
  onCheckout: () => void
  onClose: () => void
}): ReactNode {
  return (
    <div className="fixed inset-0 z-20 flex flex-col justify-end">
      {/* Scrim */}
      <button
        type="button"
        aria-label="Tutup keranjang"
        onClick={onClose}
        className="absolute inset-0 bg-ink/40"
      />

      <section
        role="dialog"
        aria-label="Keranjang"
        className="animate-sheet-up relative mx-auto flex max-h-[80vh] w-full max-w-phone flex-col rounded-t-2xl bg-surface"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="font-semibold">Keranjang</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="min-h-tap min-w-tap text-ink-muted"
          >
            ✕
          </button>
        </header>

        <ul className="flex-1 divide-y divide-line overflow-y-auto px-5">
          {view.lines.map((line) => (
            <li key={line.variantId} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="truncate">{line.name}</div>
                <div className="text-sm text-ink-muted">
                  {line.qty} × {line.unitPriceLabel}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="tabular-nums">{line.lineTotalLabel}</span>
                <button
                  type="button"
                  onClick={() => onQty(line.variantId, line.qty - 1)}
                  aria-label={`Kurangi ${line.name}`}
                  className="flex min-h-tap min-w-tap items-center justify-center rounded-full border border-line text-xl active:scale-95"
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={() => onQty(line.variantId, line.qty + 1)}
                  aria-label={`Tambah ${line.name}`}
                  className="flex min-h-tap min-w-tap items-center justify-center rounded-full bg-brand text-xl text-white active:scale-95"
                >
                  ＋
                </button>
              </div>
            </li>
          ))}
        </ul>

        <footer className="border-t border-line px-5 py-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-ink-muted">Perkiraan subtotal</span>
            <span className="font-semibold tabular-nums">{view.subtotalLabel}</span>
          </div>
          {/* The customer pays the server-computed total; taxes/charges are added
              at the cashier/confirmation. Say so plainly. */}
          <p className="mb-3 text-xs text-ink-muted">
            Pajak dan biaya layanan dihitung saat pesanan dikirim.
          </p>
          <button
            type="button"
            onClick={onCheckout}
            disabled={placing || view.isEmpty}
            className="min-h-tap w-full rounded-xl bg-brand py-3 font-semibold text-white disabled:opacity-50"
          >
            {placing ? 'Mengirim…' : 'Kirim Pesanan'}
          </button>
        </footer>
      </section>
    </div>
  )
}
