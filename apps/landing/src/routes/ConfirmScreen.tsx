import type { ReactNode } from 'react'
import { useParams, Navigate, Link } from 'react-router-dom'
import { useQrStore } from '../stores/qr.store.ts'
import { MoneyText } from '../components/MoneyText.tsx'

/**
 * Post-order confirmation. Renders the AUTHORITATIVE total from the placed
 * order's `summary` (server bill pipeline, design §6) — the customer app never
 * computes it. `accepted` reflects the outlet's auto-accept setting (§16.2):
 * true → the kitchen already has it; false → a staff member will confirm it
 * shortly. Both are normal, expected outcomes, not errors.
 *
 * If there is no placed order in the store (e.g. a direct hit or a refresh that
 * cleared state), send the customer back to the menu rather than showing an
 * empty confirmation.
 */
export function ConfirmScreen(): ReactNode {
  const { token = '' } = useParams<{ token: string }>()
  const placed = useQrStore((s) => s.placed)

  if (!placed) return <Navigate to={`/t/${token}`} replace />

  const { order, accepted } = placed

  return (
    <main className="mx-auto flex min-h-full max-w-phone flex-col items-center px-6 pt-16 text-center">
      <div className="text-5xl" aria-hidden>
        {accepted ? '✅' : '🕒'}
      </div>
      <h1 className="mt-4 text-xl font-semibold">
        {accepted ? 'Pesanan diterima' : 'Pesanan terkirim'}
      </h1>
      <p className="mt-2 text-ink-muted">
        {accepted
          ? 'Pesanan Anda sudah diteruskan ke dapur.'
          : 'Pesanan Anda menunggu konfirmasi staf. Mohon tunggu sebentar.'}
      </p>

      <dl className="mt-8 w-full rounded-2xl bg-surface p-5 text-left">
        <div className="flex items-center justify-between py-1">
          <dt className="text-ink-muted">Total</dt>
          <dd className="text-lg font-semibold tabular-nums">
            <MoneyText amount={order.summary.total} />
          </dd>
        </div>
        <div className="flex items-center justify-between py-1 text-sm text-ink-muted">
          <dt>Bayar di kasir</dt>
          <dd className="tabular-nums">
            <MoneyText amount={order.summary.amountDue} />
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-xs text-ink-muted">Pembayaran dilakukan di kasir.</p>

      <Link
        to={`/t/${token}`}
        className="mt-8 min-h-tap rounded-xl border border-line px-6 py-3 font-medium"
      >
        Pesan lagi
      </Link>
    </main>
  )
}
