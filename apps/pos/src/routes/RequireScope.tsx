/**
 * Route guard — gates the /admin subtree on session state held in the auth store.
 *
 *   no access token        → /login
 *   token but no scope     → /select-scope
 *   scoped                 → render, after loading permissions + features once
 *
 * This is navigation UX, not a security boundary (standard #5): every route it
 * reveals still hits a backend that re-checks the scoped token, the permission,
 * and any feature gate on each request.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from '../stores/auth.store.ts'
import { useAccessStore } from '../stores/access.store.ts'
import { Spinner } from '../ui/primitives.tsx'

export function RequireScope(): ReactNode {
  const accessToken = useAuthStore((s) => s.accessToken)
  const scope = useAuthStore((s) => s.scope)
  const loaded = useAccessStore((s) => s.loaded)
  const load = useAccessStore((s) => s.load)
  const [failed, setFailed] = useState(false)

  const scoped = accessToken !== null && scope !== null

  useEffect(() => {
    if (scoped && !loaded) {
      load().catch(() => setFailed(true))
    }
  }, [scoped, loaded, load])

  if (accessToken === null) return <Navigate to="/login" replace />
  if (scope === null) return <Navigate to="/select-scope" replace />

  // Access load failed (e.g. token rejected). Bounce to login; the guard clears
  // on the next render once the store has reset.
  if (failed) return <Navigate to="/login" replace />

  if (!loaded) return <Spinner label="Loading workspace…" />

  return <Outlet />
}
