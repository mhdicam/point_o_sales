/**
 * Login screen — email + password → a tenant-less token. On success we route to
 * scope selection, where the user picks the tenant/outlet that scopes every
 * subsequent request.
 */

import { useState } from 'react'
import type { ReactNode, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '../lib/api-client.ts'
import { useAuthStore } from '../stores/auth.store.ts'
import { Button, ErrorBanner, Field, Input } from '../ui/primitives.tsx'

export function LoginScreen(): ReactNode {
  const login = useAuthStore((s) => s.login)
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(email, password)
      navigate('/select-scope', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl bg-surface p-6 shadow-sm"
      >
        <h1 className="mb-1 text-lg font-semibold text-ink">Sign in</h1>
        <p className="mb-5 text-sm text-ink-muted">Brewsync admin console</p>

        {error ? (
          <div className="mb-4">
            <ErrorBanner message={error} />
          </div>
        ) : null}

        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>

        <Button type="submit" disabled={busy} className="mt-2 w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  )
}
