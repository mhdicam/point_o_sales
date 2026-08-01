/**
 * Scope selection — after login, choose the tenant (and optionally the outlet)
 * that scopes every master-data request. Selecting swaps the tenant-less token
 * for a scoped pair, then loads permissions/features and enters /admin.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '../lib/api-client.ts'
import { useAuthStore } from '../stores/auth.store.ts'
import { useAccessStore } from '../stores/access.store.ts'
import type { Membership } from '../lib/types.ts'
import { Button, EmptyState, ErrorBanner, Field, Select, Spinner } from '../ui/primitives.tsx'

export function SelectScopeScreen(): ReactNode {
  const accessToken = useAuthStore((s) => s.accessToken)
  const listMemberships = useAuthStore((s) => s.listMemberships)
  const selectScope = useAuthStore((s) => s.selectScope)
  const loadAccess = useAccessStore((s) => s.load)
  const navigate = useNavigate()

  const [memberships, setMemberships] = useState<Membership[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tenantId, setTenantId] = useState('')
  const [outletId, setOutletId] = useState('')
  const [busy, setBusy] = useState(false)

  // No token means the session lapsed — send them back to login.
  useEffect(() => {
    if (accessToken === null) {
      navigate('/login', { replace: true })
      return
    }
    listMemberships()
      .then((res) => {
        setMemberships(res)
        if (res.length === 1 && res[0]) setTenantId(res[0].tenant.id)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Unable to load workspaces'))
  }, [accessToken, listMemberships, navigate])

  const selected = memberships?.find((m) => m.tenant.id === tenantId)

  const onContinue = async (): Promise<void> => {
    if (!tenantId) return
    setError(null)
    setBusy(true)
    try {
      await selectScope(tenantId, outletId || undefined)
      await loadAccess()
      navigate('/admin/products', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to select workspace')
      setBusy(false)
    }
  }

  if (memberships === null && error === null) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <Spinner label="Loading workspaces…" />
      </div>
    )
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl bg-surface p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold text-ink">Choose a workspace</h1>
        <p className="mb-5 text-sm text-ink-muted">Select the tenant and outlet to manage.</p>

        {error ? (
          <div className="mb-4">
            <ErrorBanner message={error} />
          </div>
        ) : null}

        {memberships && memberships.length === 0 ? (
          <EmptyState title="No workspaces" hint="This account has no tenant memberships." />
        ) : (
          <>
            <Field label="Tenant">
              <Select
                value={tenantId}
                onChange={(e) => {
                  setTenantId(e.target.value)
                  setOutletId('')
                }}
              >
                <option value="">Select a tenant…</option>
                {memberships?.map((m) => (
                  <option key={m.tenant.id} value={m.tenant.id}>
                    {m.tenant.name}
                  </option>
                ))}
              </Select>
            </Field>

            {selected && selected.outlets.length > 0 ? (
              <Field label="Outlet (optional)">
                <Select value={outletId} onChange={(e) => setOutletId(e.target.value)}>
                  <option value="">All outlets (tenant-wide)</option>
                  {selected.outlets.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            <Button
              onClick={onContinue}
              disabled={busy || !tenantId}
              className="mt-2 w-full"
            >
              {busy ? 'Entering…' : 'Continue'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
