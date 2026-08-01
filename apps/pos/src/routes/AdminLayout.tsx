import type { ReactNode } from 'react'
/**
 * Admin shell — the authenticated layout: a sidebar of master-data sections and
 * an outlet for the active screen. Restructures to a top tab bar on narrow
 * screens (design §19). Nav items hide when the session lacks the permission or
 * the feature they need — UX only; the backend still guards each route.
 */

import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { PERMISSIONS } from '@brewsync/shared'
import { useAuthStore } from '../stores/auth.store.ts'
import { useAccessStore } from '../stores/access.store.ts'
import { usePermission } from '../hooks/usePermission.ts'
import { useFeature } from '../hooks/useFeature.ts'
import { Button } from '../ui/primitives.tsx'

interface NavItem {
  to: string
  label: string
  show: boolean
}

function useNavItems(): NavItem[] {
  const canProduct = usePermission(PERMISSIONS.PRODUCT_VIEW)
  const canPrice = usePermission(PERMISSIONS.PRICE_EDIT)
  const modifiersOn = useFeature('modifiers')
  return [
    { to: '/admin/products', label: 'Products', show: canProduct },
    { to: '/admin/categories', label: 'Categories', show: canProduct },
    { to: '/admin/units', label: 'Units', show: canProduct },
    { to: '/admin/modifiers', label: 'Modifiers', show: canProduct && modifiersOn },
    { to: '/admin/prices', label: 'Price lists', show: canPrice },
  ]
}

export function AdminLayout(): ReactNode {
  const items = useNavItems().filter((i) => i.show)
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const reset = useAccessStore((s) => s.reset)
  const navigate = useNavigate()

  const onLogout = (): void => {
    logout()
    reset()
    navigate('/login', { replace: true })
  }

  const linkClass = ({ isActive }: { isActive: boolean }): string =>
    `flex min-h-tap items-center rounded-lg px-3 text-sm font-medium transition ${
      isActive ? 'bg-brand/10 text-brand' : 'text-ink-muted hover:bg-surface-muted hover:text-ink'
    }`

  return (
    <div className="flex min-h-full flex-col sm:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 border-b border-line bg-surface p-4 sm:w-56 sm:border-b-0 sm:border-r">
        <div className="hidden sm:block">
          <p className="text-sm font-semibold text-ink">Brewsync</p>
          <p className="text-xs text-ink-muted">Master data</p>
        </div>
        <nav className="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible">
          {items.map((item) => (
            <NavLink key={item.to} to={item.to} className={linkClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden flex-col gap-2 sm:flex">
          {user ? <p className="truncate text-xs text-ink-muted">{user.email}</p> : null}
          <Button variant="ghost" onClick={onLogout}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  )
}
