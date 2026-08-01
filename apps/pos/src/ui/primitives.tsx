/**
 * UI primitives — a tiny Tailwind component set shared by the admin screens.
 * Deliberately minimal (no component library) so the cashier bundle stays lean.
 * Tap targets meet the 44px minimum (design §19) via the `tap` sizing tokens.
 */

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:opacity-90',
  secondary: 'bg-surface-muted text-ink hover:bg-line',
  ghost: 'bg-transparent text-ink-muted hover:bg-surface-muted',
  danger: 'bg-danger text-white hover:opacity-90',
}

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }): ReactNode {
  return (
    <button
      className={`inline-flex min-h-tap items-center justify-center rounded-lg px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASS[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string | undefined
  children: ReactNode
}): ReactNode {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-ink">{label}</span>
      {children}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </label>
  )
}

const CONTROL =
  'min-h-tap rounded-lg border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-brand'

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input className={`${CONTROL} ${className}`} {...props} />
}

export function Textarea({
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return <textarea className={`${CONTROL} py-2 ${className}`} rows={3} {...props} />
}

export function Select({
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select className={`${CONTROL} ${className}`} {...props}>
      {children}
    </select>
  )
}

export function Checkbox({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }): ReactNode {
  return (
    <label className="inline-flex min-h-tap items-center gap-2 text-sm text-ink">
      <input type="checkbox" className="h-4 w-4 accent-brand" {...props} />
      {label}
    </label>
  )
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'active' | 'muted'
}): ReactNode {
  const cls =
    tone === 'active'
      ? 'bg-brand/10 text-brand'
      : tone === 'muted'
        ? 'bg-surface-muted text-ink-muted'
        : 'bg-line text-ink'
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {children}
    </span>
  )
}

export function Spinner({ label = 'Loading…' }: { label?: string }): ReactNode {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-ink-muted" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-brand" />
      {label}
    </div>
  )
}

export function ErrorBanner({ message }: { message: string }): ReactNode {
  return (
    <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">
      {message}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }): ReactNode {
  return (
    <div className="flex flex-col items-center gap-1 p-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint ? <p className="text-xs text-ink-muted">{hint}</p> : null}
    </div>
  )
}
