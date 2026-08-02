import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQrStore } from '../stores/qr.store.ts'
import { buildMenuView, buildCartView, cartQtyOf } from '../lib/cart-view.ts'
import { MenuItemRow } from '../components/MenuItemRow.tsx'
import { CartSheet } from './CartSheet.tsx'
import { NotFoundScreen } from './NotFoundScreen.tsx'

/**
 * The customer menu: resolves the QR token to a table + dine-in menu, lets the
 * customer add items, and opens the cart bottom-sheet to check out. Phone-
 * portrait single-column (design §19). All money shown is a display preview from
 * the pure cart-view seam; the payable total is server-computed on placement.
 *
 * An invalid token (QR_INVALID) renders the opaque not-found — the security
 * opacity from §16.2 carried through to the UI (no "expired vs disabled" leak).
 */
export function MenuScreen(): ReactNode {
  const { token = '' } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { menu, cart, loading, placing, errorCode, errorMessage, loadMenu, setQty, placeOrder } =
    useQrStore()
  const [cartOpen, setCartOpen] = useState(false)

  useEffect(() => {
    void loadMenu(token)
  }, [token, loadMenu])

  const products = useMemo(() => (menu ? buildMenuView(menu) : []), [menu])
  const cartView = useMemo(() => (menu ? buildCartView(menu, cart) : null), [menu, cart])

  // An invalid/disabled QR is opaque — same screen for every reason it failed.
  if (errorCode === 'QR_INVALID') return <NotFoundScreen />

  if (loading) {
    return (
      <main className="mx-auto flex min-h-full max-w-phone items-center justify-center px-6 text-ink-muted">
        Memuat menu…
      </main>
    )
  }

  if (errorCode || !menu) {
    return (
      <main className="mx-auto flex min-h-full max-w-phone flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-danger">{errorMessage ?? 'Gagal memuat menu.'}</p>
        <button
          type="button"
          onClick={() => void loadMenu(token)}
          className="min-h-tap rounded-xl border border-line px-5"
        >
          Coba lagi
        </button>
      </main>
    )
  }

  const handleCheckout = (): void => {
    void placeOrder().then((result) => {
      if (result) navigate(`/t/${token}/confirm`)
    })
  }

  return (
    <main className="mx-auto max-w-phone px-4 pb-28">
      <header className="sticky top-0 -mx-4 border-b border-line bg-surface px-4 py-4">
        <p className="text-sm text-ink-muted">Pesan di</p>
        <h1 className="text-lg font-semibold">{menu.table.name}</h1>
      </header>

      {products.map((product) => (
        <section key={product.productId} className="border-b border-line py-2">
          <h2 className="pt-2 font-medium">{product.name}</h2>
          {product.categoryName && <p className="text-xs text-ink-muted">{product.categoryName}</p>}
          <ul className="divide-y divide-line">
            {product.variants.map((variant) => (
              <MenuItemRow
                key={variant.variantId}
                variant={variant}
                showVariantName={product.variants.length > 1}
                qty={cartQtyOf(cart, variant.variantId)}
                onQty={(next) => setQty(variant.variantId, next)}
              />
            ))}
          </ul>
        </section>
      ))}

      {cartView && !cartView.isEmpty && (
        <button
          type="button"
          onClick={() => setCartOpen(true)}
          className="fixed inset-x-0 bottom-0 z-10 mx-auto flex max-w-phone items-center justify-between bg-brand px-5 py-4 font-semibold text-white"
        >
          <span>Lihat keranjang ({cartView.itemCount})</span>
          <span className="tabular-nums">{cartView.subtotalLabel}</span>
        </button>
      )}

      {cartOpen && cartView && !cartView.isEmpty && (
        <CartSheet
          view={cartView}
          placing={placing}
          onQty={setQty}
          onClose={() => setCartOpen(false)}
          onCheckout={handleCheckout}
        />
      )}
    </main>
  )
}
