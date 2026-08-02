import type { ReactNode } from 'react'

/**
 * Opaque not-found for an invalid QR. The backend returns the SAME `QR_INVALID`
 * whether the token never existed, was rotated, expired, or the outlet simply
 * has QR ordering disabled (design §16.2) — so this screen never speculates
 * about *why*. It just tells the customer to ask staff.
 */
export function NotFoundScreen(): ReactNode {
  return (
    <main className="mx-auto flex min-h-full max-w-phone flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-4xl" aria-hidden>
        🔍
      </div>
      <h1 className="text-lg font-semibold">QR tidak berlaku</h1>
      <p className="text-ink-muted">
        Kode QR ini tidak dapat digunakan. Silakan pindai ulang kode di meja Anda atau minta bantuan
        staf.
      </p>
    </main>
  )
}
